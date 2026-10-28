import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
//#region lib/types/index.js
/**
* 无反应重试：网络故障时一直重试模型请求直到成功。
*
* 挂在 agent loop 的请求恢复扩展点 `agent/request-error` 上。开启后，凡失败码
* 命中 `retryableCodes`（默认传输/超时/空响应/服务端错误）的模型请求都会按
* 指数退避一直重试，直到成功、用户取消（随时可停）或插件被释放；失败码不在
* 集合内的失败（如限流、鉴权）原样交给下游恢复链（内置 dsh-llm-retry 等）。
*
* 会话事件与内置 `@deepseek-ai/dsh-llm-retry` 同形（`llm/retry` /
* `llm/retry-started`，mode 恒为 always），聊天界面的「等待重试模型请求」
* 提示直接复用。
*
* @module dsh-no-response-retry
*/
const name = "no-response-retry";
const inject = ["commands"];
/** 运行时开关，跨配置热加载保持；null = 跟随配置的 enabled。 */
let runtimeOverride = null;
/** Runtime schema for {@link Config}. */
const Config = z.object({
	enabled: z.boolean().default(true).description("网络故障时服务将一直重试直到成功。仍可能随时停止，但开启后可能持续消耗 API 用量。"),
	initialDelayMs: z.number().step(1).min(50).max(600000).default(1000).description("首次重试前的等待时长（毫秒），之后按指数退避。"),
	maxDelayMs: z.number().step(1).min(50).max(600000).default(30000).description("单次重试等待的上限（毫秒）。"),
	jitterRatio: z.number().min(0).max(1).default(0.2).description("退避抖动比例（0~1），错开同时发起的重试。"),
	retryableCodes: z.array(z.string()).default([
		"TRANSPORT",
		"TIMEOUT",
		"EMPTY_RESPONSE",
		"SERVER"
	]).description("视为网络故障并参与无反应重试的失败码；其余失败交给下游恢复链。")
});
function clamp(value, fallback, min, max) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(value, min), max);
}
function normalizeConfig(config = {}) {
	const retryableCodes = Array.isArray(config.retryableCodes) && config.retryableCodes.some((code) => typeof code === "string" && code.length > 0) ? config.retryableCodes.filter((code) => typeof code === "string" && code.length > 0) : [
		"TRANSPORT",
		"TIMEOUT",
		"EMPTY_RESPONSE",
		"SERVER"
	];
	const initialDelayMs = clamp(config.initialDelayMs, 1000, 50, 600000);
	const maxDelayMs = clamp(config.maxDelayMs, 30000, 50, 600000);
	const jitterRatio = clamp(config.jitterRatio, 0.2, 0, 1);
	return {
		enabled: config.enabled !== false,
		initialDelayMs,
		maxDelayMs: Math.max(maxDelayMs, initialDelayMs),
		jitterRatio,
		retryableCodes,
		policyKey: JSON.stringify([
			"no-response-retry/always",
			initialDelayMs,
			Math.max(maxDelayMs, initialDelayMs),
			jitterRatio,
			[...retryableCodes].sort()
		])
	};
}
function liveValue(value) {
	return value && typeof value.get === "function" ? value.get() : value;
}
export function apply(ctx, rawConfig = {}, internals = {}) {
	const config = normalizeConfig({
		...rawConfig,
		enabled: liveValue(rawConfig?.enabled)
	});
	const random = internals.random ?? Math.random;
	const lifetime = new AbortController();
	const codes = new Set(config.retryableCodes);
	/** 每条重试链（会话×提供方×策略）的重试计数与 id；轮次或步骤前进即重置。 */
	const chains = /* @__PURE__ */ new Map();
	const active = /* @__PURE__ */ new Set();
	function track(operation) {
		const tracked = operation.finally(() => active.delete(tracked));
		active.add(tracked);
		return tracked;
	}
	function localDelay(retry) {
		const exponent = Math.min(retry - 1, 1024);
		const exponential = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs);
		const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random();
		return Math.min(exponential * jitter, config.maxDelayMs);
	}
	function cancellableDelay(delayMs, signal) {
		const fused = AbortSignal.any([signal, lifetime.signal]);
		if (fused.aborted) return Promise.resolve(false);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				fused.removeEventListener("abort", onAbort);
				resolve(true);
			}, delayMs);
			function onAbort() {
				clearTimeout(timer);
				resolve(false);
			}
			fused.addEventListener("abort", onAbort, { once: true });
		});
	}
	function chainFor(agent, provider, turn, step) {
		const key = JSON.stringify([agent.session.id, provider, config.policyKey]);
		let chain = chains.get(key);
		if (chain === void 0 || chain.turn !== turn || chain.step !== step) {
			chain = {
				retry: 0,
				retryId: randomUUID(),
				turn,
				step
			};
			chains.set(key, chain);
		}
		return chain;
	}
	async function recover({ agent, turn, step, provider, failure, signal }, next) {
		const enabled = runtimeOverride ?? config.enabled;
		if (!enabled) return next();
		const code = failure?.code;
		if (typeof code !== "string" || !codes.has(code)) return next();
		if (signal.aborted || lifetime.signal.aborted) return next();
		const chain = chainFor(agent, provider, turn, step);
		const retry = chain.retry + 1;
		chain.retry = retry;
		const providerAfter = failure.providerRetryAfterMs;
		const delayMs = typeof providerAfter === "number" && Number.isFinite(providerAfter) && providerAfter > 0 && providerAfter <= config.maxDelayMs ? providerAfter : localDelay(retry);
		agent.session.append("llm/retry", {
			retryId: chain.retryId,
			turn,
			step,
			provider,
			mode: "always",
			policyKey: config.policyKey,
			retry,
			delayMs,
			failure
		});
		ctx.logger.info(`no-response-retry: provider "${provider}" ${code} failure, retry #${retry} in ${Math.round(delayMs)}ms`);
		if (!await cancellableDelay(delayMs, signal)) return void 0;
		agent.session.append("llm/retry-started", {
			retryId: chain.retryId,
			turn,
			step,
			retry
		});
		return { kind: "retry" };
	}
	const disposeListener = ctx.on("agent/request-error", (payload, next) => {
		if (lifetime.signal.aborted) return Promise.resolve(void 0);
		return track(recover(payload, next));
	});
	const commands = ctx.commands;
	const commandDispose = commands?.register({
		definitionId: "dsh-no-response-retry/retry",
		name: "retry",
		description: "无反应重试开关：网络故障时一直重试模型请求直到成功",
		input: { hint: "on | off | status（留空查看状态）" },
		handler: ({ rawInput }) => {
			const current = runtimeOverride ?? config.enabled;
			const state = (value) => {
				runtimeOverride = value;
				return value ? "已开启" : "已关闭";
			};
			const mode = () => runtimeOverride === null ? "跟随配置" : "会话内手动覆盖";
			switch (String(rawInput ?? "").trim().toLowerCase()) {
				case "on":
					return { kind: "success", text: `${state(true)}无反应重试（${mode()}）：网络故障时将一直重试直到成功。` };
				case "off":
					return { kind: "success", text: `${state(false)}无反应重试（${mode()}）：网络故障恢复默认的有限重试策略。` };
				case "":
				case "status":
					return {
						kind: "success",
						text: current ? `无反应重试：开启（${mode()}）。网络故障时一直重试直到成功；仍可能随时停止，但会持续消耗 API 用量。` : "无反应重试：关闭。网络故障按默认策略最多重试 5 次。"
					};
				default:
					return { kind: "error", text: "用法：/retry on | off | status" };
			}
		}
	});
	ctx.effect(() => async () => {
		commandDispose?.();
		disposeListener();
		lifetime.abort(new Error("no-response-retry plugin disposed"));
		await Promise.allSettled([...active]);
	}, "no-response-retry: abort and drain active recovery");
}
//#endregion
export { Config, name, inject };
