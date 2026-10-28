import assert from "node:assert";
import { apply } from "../lib/index.js";

function makeCtx(config) {
	const ctx = {
		listeners: [],
		on(event, handler) {
			ctx.listeners.push([event, handler]);
			return () => {
				ctx.listeners = ctx.listeners.filter((l) => l[1] !== handler);
			};
		},
		logger: { info() {}, warn() {}, error() {} },
		commands: {
			register(def) {
				ctx.command = def;
				return () => { ctx.command = undefined; };
			}
		},
		effect(fn) {
			ctx.dispose = fn();
		}
	};
	apply(ctx, config, { random: () => 1 });
	return ctx;
}

function payload(sessionId, turn, step, code, extra = {}) {
	const appended = [];
	return {
		appended,
		p: {
			agent: { session: { id: sessionId, append(type, data) { appended.push([type, data]); } } },
			turn,
			step,
			provider: "magpie",
			failure: { message: "boom", code, ...extra },
			signal: new AbortController().signal,
			retryPolicy: { mode: "normal", maxRetries: 5, retryableCodes: ["TRANSPORT"], backoff: {} },
			...extra
		},
		next: async () => undefined
	};
}

// 1. listener registered
{
	const ctx = makeCtx({ initialDelayMs: 30, maxDelayMs: 30 });
	assert.equal(ctx.listeners.length, 1);
	assert.equal(ctx.listeners[0][0], "agent/request-error");
}

// 2. network failure → infinite retries, event shape matches llm/retry schema
{
	const ctx = makeCtx({ initialDelayMs: 30, maxDelayMs: 30 });
	const { p, next, appended } = payload("s1", 1, 1, "TRANSPORT");
	const handler = ctx.listeners[0][1];
	for (let i = 1; i <= 12; i++) {
		const decision = await handler(p, next);
		assert.deepEqual(decision, { kind: "retry" }, `retry #${i}`);
		assert.equal(appended.at(-2)[0], "llm/retry");
		const data = appended.at(-2)[1];
		assert.deepEqual(Object.keys(data).sort(), ["delayMs", "failure", "mode", "policyKey", "provider", "retry", "retryId", "step", "turn"]);
		assert.equal(data.mode, "always");
		assert.equal(data.retry, i);
		assert.equal(appended.at(-1)[0], "llm/retry-started");
	}
	console.log("ok: retries 12 times, stable event shape");
	ctx.dispose();
}

// 3. per-turn/step chain reset
{
	const ctx = makeCtx({ initialDelayMs: 30, maxDelayMs: 30 });
	const handler = ctx.listeners[0][1];
	const a = payload("s1", 1, 1, "TIMEOUT");
	await handler(a.p, a.next);
	await handler(a.p, a.next);
	const b = payload("s1", 1, 2, "TIMEOUT"); // new step
	await handler(b.p, b.next);
	assert.equal(b.appended.at(-2)[1].retry, 1, "new step resets counter");
	assert.notEqual(b.appended.at(-2)[1].retryId, a.appended[0][1].retryId, "new chain id");
	console.log("ok: chain resets on step advance");
	ctx.dispose();
}

// 4. non-network codes delegate to next()
{
	const ctx = makeCtx({ initialDelayMs: 30, maxDelayMs: 30 });
	const handler = ctx.listeners[0][1];
	for (const code of ["RATE_LIMIT", "INVALID_CREDENTIAL", "AUTH", "CONTEXT_WINDOW_EXCEEDED"]) {
		const { p, next } = payload("s1", 1, 1, code);
		let delegated = false;
		const decision = await handler(p, async () => { delegated = true; return undefined; });
		assert.equal(decision, undefined, code);
		assert.equal(delegated, true, code);
	}
	console.log("ok: RATE_LIMIT/AUTH delegate downstream");
	ctx.dispose();
}

// 5. provider Retry-After within cap honored; beyond cap falls back to local backoff
{
	const ctx = makeCtx({ initialDelayMs: 30, maxDelayMs: 100 });
	const handler = ctx.listeners[0][1];
	const within = payload("s1", 1, 1, "EMPTY_RESPONSE", { providerRetryAfterMs: 80 });
	await handler(within.p, within.next);
	assert.equal(within.appended.at(-2)[1].delayMs, 80);
	const beyond = payload("s1", 1, 1, "EMPTY_RESPONSE", { providerRetryAfterMs: 5000 });
	await handler(beyond.p, beyond.next);
	assert.ok(beyond.appended.at(-2)[1].delayMs <= 100, "falls back to local delay");
	console.log("ok: Retry-After handling");
	ctx.dispose();
}

// 6. config enabled:false → delegate; /retry command toggles runtime override
{
	const ctx = makeCtx({ enabled: false, initialDelayMs: 30, maxDelayMs: 30 });
	const handler = ctx.listeners[0][1];
	const { p } = payload("s1", 1, 1, "TRANSPORT");
	let delegated = false;
	assert.equal(await handler(p, async () => { delegated = true; }), undefined);
	assert.equal(delegated, true);
	// /retry on
	const onReply = ctx.command.handler({ rawInput: "on" });
	assert.equal(onReply.kind, "success");
	assert.ok(onReply.text.includes("已开启"), onReply.text);
	assert.ok(ctx.command.handler({ rawInput: "status" }).text.includes("开启（会话内手动覆盖）"));
	let delegatedAgain = false;
	const decision = await handler(p, async () => { delegatedAgain = true; });
	assert.deepEqual(decision, { kind: "retry" });
	assert.equal(delegatedAgain, false, "retry decision must not call next()");
	// /retry off → back to delegate
	assert.deepEqual(ctx.command.handler({ rawInput: "off" }).kind, "success");
	delegated = false;
	await handler(p, async () => { delegated = true; });
	assert.equal(delegated, true);
	// bad arg
	assert.deepEqual(ctx.command.handler({ rawInput: "xyz" }), { kind: "error", text: "用法：/retry on | off | status" });
	console.log("ok: config off + /retry on|off|status");
	ctx.dispose();
}

// 7. aborted signal before scheduling → delegate
{
	const ctx = makeCtx({ initialDelayMs: 30, maxDelayMs: 30 });
	const handler = ctx.listeners[0][1];
	const { p } = payload("s1", 1, 1, "TRANSPORT");
	const ac = new AbortController();
	ac.abort();
	p.signal = ac.signal;
	let delegated = false;
	await handler(p, async () => { delegated = true; });
	assert.equal(delegated, true);
	console.log("ok: aborted signal delegates (user stop is always possible)");
	ctx.dispose();
}

// 8. effect disposal aborts pending waits
{
	const ctx = makeCtx({ initialDelayMs: 1000, maxDelayMs: 1000 });
	const handler = ctx.listeners[0][1];
	const { p } = payload("s1", 1, 1, "TRANSPORT");
	const pending = handler(p, async () => undefined);
	await new Promise((r) => setTimeout(r, 50));
	await ctx.dispose();
	const decision = await pending;
	assert.equal(decision, undefined, "aborted during backoff → no retry");
	console.log("ok: dispose aborts in-flight backoff");
}

console.log("\nALL SMOKE TESTS PASSED");
