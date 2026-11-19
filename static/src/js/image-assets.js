import { assetBlob, assetInfo, thumbnail, retainAsset } from "./storage.js";

const MaxCachedImages = 64,
	MaxCachedBytes = 48 * 1024 * 1024,
	PreviewScale = 1.5,
	PreviewStep = 64,
	ResizeDelay = 180;

const imageCache = new Map(),
	imageBindings = new WeakMap(),
	responsiveBindings = new WeakMap(),
	resizeObserver = new ResizeObserver(handleImageResize);

let cachedBytes = 0;

export function acquireImage(id, max = 0, fit = "contain", purpose = "") {
	const key = `${id}:${max}:${fit}:${purpose}`;

	let entry = imageCache.get(key);

	if (!entry) {
		entry = {
			count: 0,
			url: null,
			bytes: 0,
			controller: new AbortController(),
			release: null,
		};

		imageCache.set(key, entry);

		entry.promise = loadImageURL(entry, id, max, fit, purpose);
	}

	if (!entry.count) {
		entry.release = retainAsset(id);
	}

	entry.count++;

	imageCache.delete(key);
	imageCache.set(key, entry);

	let released = false;

	return {
		url: entry.promise,
		release() {
			if (released) {
				return;
			}

			released = true;

			entry.count--;

			if (!entry.count) {
				entry.release?.();
				entry.release = null;
			}

			if (!entry.count && (!entry.url || !max)) {
				discardImage(key, entry);
			}

			trimImageCache();
		},
	};
}

async function loadImageURL(entry, id, max, fit, purpose) {
	const signal = entry.controller.signal,
		record = max ? await thumbnail(id, max, signal, fit, purpose) : { blob: await assetBlob(id), ...await assetInfo(id) };

	signal.throwIfAborted();

	entry.bytes = record.blob.size + record.width * record.height * 4;
	entry.url = URL.createObjectURL(record.blob);

	cachedBytes += entry.bytes;

	trimImageCache();

	return entry.url;
}

function discardImage(key, entry) {
	if (imageCache.get(key) !== entry) {
		return;
	}

	imageCache.delete(key);

	entry.controller.abort();
	entry.release?.();

	if (entry.url) {
		URL.revokeObjectURL(entry.url);

		cachedBytes -= entry.bytes;
	}
}

function trimImageCache() {
	for (const [key, entry] of imageCache) {
		if (imageCache.size <= MaxCachedImages && cachedBytes <= MaxCachedBytes) {
			break;
		}

		if (!entry.count) {
			discardImage(key, entry);
		}
	}
}

export function releaseImage(image) {
	const binding = responsiveBindings.get(image);
	if (binding) {
		clearTimeout(binding.timer);

		binding.pending?.release();
		resizeObserver.unobserve(image);
		responsiveBindings.delete(image);
	}

	releaseLease(image);
}

function releaseLease(image) {
	imageBindings.get(image)?.release();
	imageBindings.delete(image);

	image.removeAttribute("src");
}

export function bindImage(image, id, max = 0, fit = "contain", purpose = "") {
	releaseImage(image);
	attachImage(image, id, max, fit, purpose);
}

export function bindResponsiveImage(image, id) {
	releaseImage(image);

	image.dataset.assetId = id;

	responsiveBindings.set(image, {
		id: id,
		max: 0,
		displayedMax: 0,
		pending: null,
		timer: null,
	});

	resizeObserver.observe(image);
}

function handleImageResize(observations) {
	for (const observation of observations) {
		const image = observation.target,
			binding = responsiveBindings.get(image);

		if (!binding || !observation.contentRect.width || !observation.contentRect.height) {
			continue;
		}

		const edge = Math.max(observation.contentRect.width, observation.contentRect.height),
			max = Math.ceil(edge * devicePixelRatio * PreviewScale / PreviewStep) * PreviewStep;

		clearTimeout(binding.timer);

		if (!binding.max) {
			resizeImage(image, binding, max);
		} else if (max > binding.max || max < binding.max / 2) {
			// Keep adequate previews through small resizes, and encode only after resizing settles.
			binding.timer = setTimeout(() => resizeImage(image, binding, max), ResizeDelay);
		}
	}
}

function resizeImage(image, binding, max) {
	if (responsiveBindings.get(image) !== binding) {
		return;
	}

	binding.pending?.release();

	const lease = acquireImage(binding.id, max, "cover", "preview");

	binding.pending = lease;
	binding.max = max;

	image.decoding = "async";

	lease.url.then(url => {
		if (responsiveBindings.get(image) === binding && binding.pending === lease) {
			const previous = imageBindings.get(image);

			imageBindings.set(image, lease);

			binding.pending = null;
			binding.displayedMax = max;

			image.src = url;

			previous?.release();
		}
	}).catch(error => {
		lease.release();

		if (binding.pending === lease) {
			binding.pending = null;
			binding.max = binding.displayedMax;
		}

		if (error.name !== "AbortError") {
			console.error("Image resize failed", error);
		}
	});
}

function attachImage(image, id, max, fit, purpose) {
	if (!id) {
		return;
	}

	const lease = acquireImage(id, max, fit, purpose);

	imageBindings.set(image, lease);

	image.dataset.assetId = id;
	image.decoding = "async";

	lease.url.then(url => {
		if (imageBindings.get(image) === lease) {
			image.src = url;
		}
	}).catch(error => {
		if (imageBindings.get(image) === lease) {
			releaseImage(image);
		}

		if (error.name !== "AbortError") {
			console.error("Image load failed", error);
		}
	});
}

export function releaseImages(root) {
	root.querySelectorAll("img[data-asset-id]").forEach(releaseImage);
}

export async function imageDataURL(id, signal) {
	const blob = await assetBlob(id);

	signal?.throwIfAborted();

	return new Promise((resolve, reject) => {
		const reader = new FileReader(),
			abort = () => reader.abort();

		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(reader.error);
		reader.onabort = () => reject(new DOMException("Aborted", "AbortError"));
		reader.onloadend = () => signal?.removeEventListener("abort", abort);

		signal?.addEventListener("abort", abort, { once: true });

		reader.readAsDataURL(blob);
	});
}
