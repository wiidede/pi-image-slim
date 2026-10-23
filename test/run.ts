/**
 * Test suite for pi-image-slim. No network, no fixtures on disk.
 *
 *   node test/run.ts
 */

import assert from "node:assert/strict";
import extension, { stripOldImages } from "../index.ts";

// ─────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────

let passed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void): void {
	try {
		fn();
		passed++;
		console.log(`  ok   ${name}`);
	} catch (error) {
		failures.push(name);
		console.log(`  FAIL ${name}`);
		console.log(`       ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Synthesise a base64 blob of roughly `bytes` size. */
function fakeBase64(bytes: number): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let out = "";
	for (let i = 0; i < bytes; i++) out += alphabet[i % 64];
	return out;
}

const MB = 1_000_000;
const sizeOf = (payload: unknown): number => JSON.stringify(payload).length;
/** Each image block carries exactly one `"image_url":` key. */
const countImages = (payload: unknown): number =>
	JSON.stringify(payload).split('"image_url":').length - 1;
const countPlaceholders = (payload: unknown): number =>
	JSON.stringify(payload).split("removed from history").length - 1;

/** A read → tool result → image carrier cycle, the way Pi serialises it. */
function imageCycle(index: number, bytes = 1000, path = `/proj/img${index}.png`): unknown[] {
	return [
		{
			role: "assistant",
			content: null,
			tool_calls: [
				{
					id: `c${index}`,
					type: "function",
					function: { name: "read", arguments: JSON.stringify({ path }) },
				},
			],
		},
		{
			role: "tool",
			content: `Read image file [image/png]\nImage file: ${path}`,
			tool_call_id: `c${index}`,
		},
		{
			role: "user",
			content: [
				{ type: "text", text: "Attached image(s) from tool result:" },
				{ type: "image_url", image_url: { url: `data:image/png;base64,${fakeBase64(bytes)}` } },
			],
		},
	];
}

function payloadWith(turns: { images: number; bytes?: number }[]): { messages: unknown[] } {
	const messages: unknown[] = [{ role: "system", content: "sys" }];
	let n = 0;
	for (const [t, turn] of turns.entries()) {
		messages.push({ role: "user", content: `turn ${t}` });
		for (let i = 0; i < turn.images; i++) messages.push(...imageCycle(n++, turn.bytes));
	}
	return { messages };
}

// ─────────────────────────────────────────────────────────────
// tests
// ─────────────────────────────────────────────────────────────

console.log("pi-image-slim tests\n");

console.log("turn scoping");
check("current turn's images are sent in full", () => {
	const payload = payloadWith([{ images: 10 }]);
	const before = countImages(payload);
	assert.equal(stripOldImages(payload, "openai-completions"), 0);
	assert.equal(countImages(payload), before);
});

check("previous turn's images become placeholders", () => {
	const payload = payloadWith([{ images: 3 }, { images: 2 }]);
	assert.equal(stripOldImages(payload, "openai-completions"), 3);
	assert.equal(countPlaceholders(payload), 3);
	assert.equal(countImages(payload), 2);
});

check("every image is uploaded in full exactly once across a session", () => {
	// Simulate 5 consecutive requests, each appending one turn of 3 images.
	const messages: unknown[] = [{ role: "system", content: "sys" }];
	let n = 0;
	let totalSentBytes = 0;
	for (let turn = 0; turn < 5; turn++) {
		messages.push({ role: "user", content: `turn ${turn}` });
		for (let i = 0; i < 3; i++) messages.push(...imageCycle(n++, 200_000));
		const payload = { messages: structuredClone(messages) };
		stripOldImages(payload, "openai-completions");
		totalSentBytes += sizeOf(payload);
	}
	const fullySent = 15 * 200_000;
	// 15 images × 200 KB sent once = 3 MB; plus the last turn re-sent a few times.
	assert.ok(totalSentBytes < fullySent * 1.6, `sent ${totalSentBytes} vs once ${fullySent}`);
});

check("placeholder names the right file", () => {
	const payload = payloadWith([{ images: 2 }, { images: 1 }]);
	stripOldImages(payload, "openai-completions");
	const serialized = JSON.stringify(payload);
	assert.ok(serialized.includes(": /proj/img0.png —"), "img0 path missing");
	assert.ok(serialized.includes(": /proj/img1.png —"), "img1 path missing");
	assert.ok(!serialized.includes(": /proj/img2.png —"), "current turn's image was stripped");
});

check("no real user message means nothing is stripped", () => {
	const payload = { messages: [...imageCycle(0), ...imageCycle(1)] };
	assert.equal(stripOldImages(payload, "openai-completions"), 0);
});

check("a user message carrying an image still opens a new turn", () => {
	const payload = payloadWith([{ images: 1 }]);
	payload.messages.push({
		role: "user",
		content: [
			{ type: "text", text: "and this one?" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
		],
	});
	// The pasted image has no tool_result and no synthetic prefix, so it is real input.
	assert.equal(stripOldImages(payload, "openai-completions"), 1);
	assert.equal(countImages(payload), 1);
});

console.log("\nprotocol shapes");
check("openai-completions → { type: 'text' }", () => {
	const payload = payloadWith([{ images: 1 }, { images: 1 }]);
	stripOldImages(payload, "openai-completions");
	assert.ok(JSON.stringify(payload).includes('{"type":"text","text":"[image removed'));
});

check("openai-responses → { type: 'input_text' }", () => {
	const payload = payloadWith([{ images: 1 }, { images: 1 }]);
	stripOldImages(payload, "openai-responses");
	assert.ok(JSON.stringify(payload).includes('{"type":"input_text"'));
});

check("google / bedrock → bare { text }", () => {
	for (const api of ["google-generative-ai", "bedrock-converse-stream"]) {
		const payload = payloadWith([{ images: 1 }, { images: 1 }]);
		stripOldImages(payload, api);
		assert.ok(JSON.stringify(payload).includes('{"text":"[image removed'), api);
	}
});

check("unknown api falls back to { type: 'text' }", () => {
	const payload = payloadWith([{ images: 1 }, { images: 1 }]);
	stripOldImages(payload, undefined);
	assert.ok(JSON.stringify(payload).includes('{"type":"text","text":"[image removed'));
});

console.log("\nimage detection across protocols");
check("detects every image block shape", () => {
	// Each payload holds one image in an earlier turn, then a real user message
	// that closes the turn — so the image is eligible for stripping.
	const trailingUser: Record<string, unknown> = {
		"openai-completions image_url": { role: "user", content: "next" },
		"openai-responses input_image": { role: "user", content: [{ type: "input_text", text: "next" }] },
		"anthropic nested tool_result": { role: "user", content: [{ type: "text", text: "next" }] },
		"google inlineData": { role: "user", parts: [{ text: "next" }] },
		"bedrock image block": { role: "user", content: "next" },
	};
	const shapes: Record<string, unknown> = {
		"openai-completions image_url": {
			messages: imageCycle(7, 100),
		},
		"openai-responses input_image": {
			input: [
				{
					type: "function_call_output",
					output: [{ type: "input_image", image_url: "data:x" }],
				},
			],
		},
		"anthropic nested tool_result": {
			messages: [
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "t1",
							content: [{ type: "image", source: { type: "base64", data: "x" } }],
						},
					],
				},
			],
		},
		"google inlineData": {
			contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "x" } }] }],
		},
		"bedrock image block": {
			messages: [{ role: "user", content: [{ image: { format: "png", source: {} } }] }],
		},
	};
	for (const [name, payload] of Object.entries(shapes)) {
		const container = payload as Record<string, unknown>;
		const list = (container.messages ?? container.input ?? container.contents) as unknown[];
		list.push(trailingUser[name]);
		const removed = stripOldImages(container, "openai-completions");
		assert.ok(removed > 0, `${name}: expected a removal, got ${removed}`);
	}
});

check("clipboard images without a path get the generic placeholder", () => {
	const payload = {
		messages: [
			{ role: "user", content: "hi" },
			{ role: "user", content: [{ type: "image_url", image_url: { url: "data:x" } }] },
			{ role: "user", content: "next turn" },
			{ role: "user", content: [{ type: "image_url", image_url: { url: "data:y" } }] },
		],
	};
	assert.equal(stripOldImages(payload, "openai-completions"), 1);
	assert.ok(JSON.stringify(payload).includes("re-attach it"));
});

console.log("\nrobustness");
check("idempotent", () => {
	const payload = payloadWith([{ images: 2 }, { images: 2 }]);
	const first = stripOldImages(payload, "openai-completions");
	const snapshot = JSON.stringify(payload);
	const second = stripOldImages(payload, "openai-completions");
	assert.equal(first, 2);
	assert.equal(second, 0);
	assert.equal(JSON.stringify(payload), snapshot);
});

check("malformed payloads are safe no-ops", () => {
	for (const bad of [null, undefined, 42, "text", [], {}, { messages: "not-an-array" }]) {
		assert.equal(stripOldImages(bad, "openai-completions"), 0, JSON.stringify(bad));
	}
});

check("content arrays never end up empty", () => {
	const payload = { messages: [...imageCycle(0, 50), { role: "user", content: [{ type: "image_url", image_url: { url: "d" } }] }, { role: "user", content: "x" }] };
	stripOldImages(payload, "openai-completions");
	for (const message of payload.messages as { content: unknown }[]) {
		if (Array.isArray(message.content)) {
			assert.ok(message.content.length > 0, "empty content array left behind");
		}
	}
});

console.log("\nhooks");
check("registers both hooks and wires them up", async () => {
	const handlers: Record<string, (...args: never[]) => unknown> = {};
	const pi = {
		on: (event: string, handler: (...args: never[]) => unknown) => {
			handlers[event] = handler;
			return () => {};
		},
	};
	extension(pi as never);
	assert.ok(handlers.tool_result, "tool_result not registered");
	assert.ok(handlers.before_provider_request, "before_provider_request not registered");

	const result = (await handlers.tool_result({
		input: { path: "/a/b.png" },
		content: [{ type: "image", data: "AAA", mimeType: "image/png" }],
	} as never)) as { content: { text?: string }[] } | undefined;
	assert.ok(result, "image result without a path note was left alone");
	assert.ok(result.content.at(-1)?.text === "Image file: /a/b.png");

	const ctx = { model: { api: "openai-completions" } };
	const payload = payloadWith([{ images: 2 }, { images: 1 }]);
	const out = (await handlers.before_provider_request({ payload } as never, ctx as never)) as {
		removed?: number;
	};
	assert.equal(out, payload);
});

check("both hooks are async", () => {
	const handlers: Record<string, unknown> = {};
	extension({ on: (e: string, h: unknown) => ((handlers[e] = h), () => {}) } as never);
	for (const name of ["tool_result", "before_provider_request"]) {
		const fn = handlers[name] as (...a: never[]) => unknown;
		assert.equal(fn.constructor.name, "AsyncFunction", `${name} should be async`);
	}
});

console.log("\nbandwidth, realistic sizes");
check("30 MB of screenshots collapses to one turn's worth", () => {
	const sizes = [3.42, 3.06, 3.01, 2.84, 2.6, 2.56, 1.82, 1.32, 1.21, 1.15];
	const messages: unknown[] = [{ role: "system", content: "sys" }];
	let n = 0;
	for (let turn = 0; turn < 4; turn++) {
		messages.push({ role: "user", content: `turn ${turn}` });
		for (const mb of sizes.slice(turn * 2, turn * 2 + 2)) {
			messages.push(...imageCycle(n++, Math.round(mb * MB)));
		}
	}
	const payload = { messages: structuredClone(messages) };
	const before = sizeOf(payload);
	const removed = stripOldImages(payload, "openai-completions");
	const after = sizeOf(payload);
	const ratio = before / after;
	console.log(
		`       ${(before / MB).toFixed(2)} MB → ${(after / MB).toFixed(2)} MB ` +
			`(${ratio.toFixed(1)}× smaller, ${removed} images replaced)`,
	);
	assert.ok(ratio > 3, `expected a large reduction, got ${ratio.toFixed(2)}×`);
});

// ─────────────────────────────────────────────────────────────
// summary
// ─────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
	for (const name of failures) console.log(`  - ${name}`);
	process.exitCode = 1;
}