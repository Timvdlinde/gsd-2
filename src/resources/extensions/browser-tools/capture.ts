/**
 * browser-tools — page state capture
 *
 * Functions for capturing compact page state, screenshots, and summaries.
 * Used by tool implementations for post-action feedback.
 */

import type { Frame, Page } from "playwright";
import type { CompactPageState, CompactSelectorState } from "./state.js";
import { formatCompactStateSummary } from "./utils.js";

// Anthropic API rejects images > 2000px in multi-image requests.
// Cap at 1568px (recommended optimal size) to stay well within limits.
const MAX_SCREENSHOT_DIM = 1568;

// ---------------------------------------------------------------------------
// Compact page state capture
// ---------------------------------------------------------------------------

export async function captureCompactPageState(
	p: Page,
	options: { selectors?: string[]; includeBodyText?: boolean; target?: Page | Frame } = {},
): Promise<CompactPageState> {
	const selectors = Array.from(new Set((options.selectors ?? []).filter(Boolean)));
	const target = options.target ?? p;
	const domState = await target.evaluate(({ selectors, includeBodyText }) => {
		const selectorStates: Record<string, {
			exists: boolean;
			visible: boolean;
			value: string;
			checked: boolean | null;
			text: string;
		}> = {};
		for (const selector of selectors) {
			let el: Element | null = null;
			try {
				el = document.querySelector(selector);
			} catch {
				el = null;
			}
			if (!el) {
				selectorStates[selector] = {
					exists: false,
					visible: false,
					value: "",
					checked: null,
					text: "",
				};
				continue;
			}
			const htmlEl = el as HTMLElement;
			const style = window.getComputedStyle(htmlEl);
			const rect = htmlEl.getBoundingClientRect();
			const visible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
			const input = el as HTMLInputElement;
			selectorStates[selector] = {
				exists: true,
				visible,
				value:
					el instanceof HTMLInputElement ||
					el instanceof HTMLTextAreaElement ||
					el instanceof HTMLSelectElement
						? el.value
						: htmlEl.getAttribute("value") || "",
				checked: el instanceof HTMLInputElement && ["checkbox", "radio"].includes(input.type) ? input.checked : null,
				text: (htmlEl.innerText || htmlEl.textContent || "").trim().replace(/\s+/g, " ").slice(0, 160),
			};
		}

		const focused = document.activeElement as HTMLElement | null;
		const focusedDesc = focused && focused !== document.body && focused !== document.documentElement
			? `${focused.tagName.toLowerCase()}${focused.id ? '#' + focused.id : ''}${focused.getAttribute('aria-label') ? ' "' + focused.getAttribute('aria-label') + '"' : ''}`
			: "";
		const headings = Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 5).map((h) => (h.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80));
		const dialog = document.querySelector('[role="dialog"]:not([hidden]),dialog[open]');
		const dialogTitle = dialog?.querySelector('[role="heading"],[aria-label]')?.textContent?.trim().slice(0, 80) ?? "";
		const bodyText = includeBodyText
			? (document.body?.innerText || document.body?.textContent || "").trim().replace(/\s+/g, ' ').slice(0, 4000)
			: "";
		return {
			url: window.location.href,
			title: document.title,
			focus: focusedDesc,
			headings,
			bodyText,
			counts: {
				landmarks: document.querySelectorAll('[role="main"],[role="banner"],[role="navigation"],[role="contentinfo"],[role="complementary"],[role="search"],[role="form"],[role="dialog"],[role="alert"],main,header,nav,footer,aside,section,form,dialog').length,
				buttons: document.querySelectorAll('button,[role="button"]').length,
				links: document.querySelectorAll('a[href]').length,
				inputs: document.querySelectorAll('input,textarea,select').length,
			},
			dialog: {
				count: document.querySelectorAll('[role="dialog"]:not([hidden]),dialog[open]').length,
				title: dialogTitle,
			},
			selectorStates,
		};
	}, { selectors, includeBodyText: options.includeBodyText === true });
	// URL and title always come from the Page, not the frame
	return { ...domState, url: p.url(), title: await p.title() };
}

// ---------------------------------------------------------------------------
// Post-action summary
// ---------------------------------------------------------------------------

/** Lightweight page summary after an action. Returns ~50-150 tokens instead of full tree. */
export async function postActionSummary(p: Page, target?: Page | Frame): Promise<string> {
	try {
		const state = await captureCompactPageState(p, { target });
		return formatCompactStateSummary(state);
	} catch {
		return "[summary unavailable]";
	}
}

// ---------------------------------------------------------------------------
// Screenshot helpers
// ---------------------------------------------------------------------------

/**
 * If either dimension of the image buffer exceeds MAX_SCREENSHOT_DIM,
 * downscale proportionally using the browser's canvas (zero dependencies).
 * Returns the original buffer unchanged if already within limits.
 */
export async function constrainScreenshot(
	page: Page,
	buffer: Buffer,
	mimeType: string,
	quality: number,
): Promise<Buffer> {
	let width: number;
	let height: number;

	if (mimeType === "image/png") {
		width = buffer.readUInt32BE(16);
		height = buffer.readUInt32BE(20);
	} else {
		width = 0;
		height = 0;
		for (let i = 0; i < buffer.length - 8; i++) {
			if (buffer[i] === 0xff && (buffer[i + 1] === 0xc0 || buffer[i + 1] === 0xc2)) {
				height = buffer.readUInt16BE(i + 5);
				width = buffer.readUInt16BE(i + 7);
				break;
			}
		}
	}

	if (width <= MAX_SCREENSHOT_DIM && height <= MAX_SCREENSHOT_DIM) {
		return buffer;
	}

	const b64 = buffer.toString("base64");
	const result = await page.evaluate(
		async ({ b64, mime, maxDim, q }) => {
			const img = new Image();
			await new Promise<void>((resolve, reject) => {
				img.onload = () => resolve();
				img.onerror = reject;
				img.src = `data:${mime};base64,${b64}`;
			});
			const scale = Math.min(maxDim / img.width, maxDim / img.height);
			const w = Math.round(img.width * scale);
			const h = Math.round(img.height * scale);
			const canvas = document.createElement("canvas");
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext("2d")!;
			ctx.drawImage(img, 0, 0, w, h);
			return canvas.toDataURL(mime, q / 100);
		},
		{ b64, mime: mimeType, maxDim: MAX_SCREENSHOT_DIM, q: quality },
	);

	const resizedB64 = result.split(",")[1];
	return Buffer.from(resizedB64, "base64");
}

/** Capture a JPEG screenshot for error debugging. Returns base64 or null. */
export async function captureErrorScreenshot(p: Page | null): Promise<{ data: string; mimeType: string } | null> {
	if (!p) return null;
	try {
		let buf = await p.screenshot({ type: "jpeg", quality: 60, scale: "css" });
		buf = await constrainScreenshot(p, buf, "image/jpeg", 60);
		return { data: buf.toString("base64"), mimeType: "image/jpeg" };
	} catch {
		return null;
	}
}
