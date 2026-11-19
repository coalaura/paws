import Dexie from "dexie";

import { processBlob } from "./image-processing.js";

const DatabaseName = "paws",
	AssetSchemaVersion = 2,
	MaxThumbnails = 256,
	MaxThumbnailBytes = 64 * 1024 * 1024,
	MaxDerivatives = 128,
	MaxDerivativeBytes = 64 * 1024 * 1024,
	CollectionDelay = 5000,
	AssetGracePeriod = 60000;

const settings = new Map(),
	jobSnapshots = new Map(),
	assetHolds = new Map(),
	pendingDerivatives = new Map();

let database,
	pendingWrites = Promise.resolve(),
	migrating = true,
	jobOrder = "",
	collectionTimer,
	collectionDue = 0;

export async function connectDB() {
	if (database) {
		return;
	}

	database = new Dexie(DatabaseName);

	database.version(1).stores({
		kv: "&key",
	});

	database.version(AssetSchemaVersion).stores({
		kv: "&key",
		jobs: "&id",
		assets: "&id",
		assetInfo: "&id,derivativeKey",
		thumbnails: "&key,source,lastUsed",
		settings: "&key",
	});

	await database.open();
	await migrate();

	migrating = false;

	scheduleCollection();

	for (const row of await database.settings.toArray()) {
		settings.set(row.key, row.value);
	}
}

async function migrate() {
	const schema = await database.settings.get("assetSchema");
	if (schema?.value === AssetSchemaVersion) {
		return;
	}

	const legacy = await database.kv.toArray(),
		values = new Map(legacy.map(row => [row.key, row.value])),
		converted = [],
		references = [],
		imported = new Map();

	const convert = source => {
		if (!imported.has(source)) {
			imported.set(source, importAsset(source));
		}

		return imported.get(source);
	};

	// Never modify the v1 rows during conversion. Failed/interrupted migrations can restart.
	for (const entry of values.get("jobs") || []) {
		const job = { ...entry, payload: { ...entry.payload } };

		for (const field of ["result", "originalResult"]) {
			if (job[field]) {
				job[field] = await convert(job[field]);
			}
		}

		job.payload.images = await Promise.all((job.payload.images || []).map(convert));

		// Legacy payloads already contain model-ready pixels; retry them without a new limit.
		job.referenceResolution = 0;

		converted.push(job);
	}

	for (const entry of values.get("referenceImages") || []) {
		const reference = typeof entry === "string" ? { original: entry, processed: entry } : { ...entry };

		reference.original = await convert(reference.original || reference.processed);

		// Rebuild intentional edits at original resolution; the old processed image may be downsized.
		if (reference.crop || reference.brightness || reference.contrast) {
			reference.processed = await deriveAsset(reference.original, {
				crop: reference.crop,
				brightness: reference.brightness || 0,
				contrast: reference.contrast || 0,
				format: "image/png",
			});
		} else {
			reference.processed = reference.original;
		}

		references.push(reference);
	}

	await database.transaction("rw", database.jobs, database.settings, database.kv, async () => {
		await database.jobs.bulkPut(converted);

		for (const row of legacy) {
			if (row.key !== "jobs" && row.key !== "referenceImages") {
				await database.settings.put({ key: row.key, value: row.value });
			}
		}

		await database.settings.bulkPut([
			{ key: "jobOrder", value: converted.map(job => job.id) },
			{ key: "referenceImages", value: references },
			{ key: "assetSchema", value: AssetSchemaVersion },
		]);

		await database.kv.clear();
	});
}

export async function loadJobs() {
	const records = await database.jobs.toArray(),
		byId = new Map(records.map(job => [job.id, job])),
		order = load("jobOrder", []),
		result = [];

	for (const id of order) {
		if (byId.has(id)) {
			result.push(byId.get(id));
			byId.delete(id);
		}
	}

	result.push(...byId.values());

	for (const job of result) {
		jobSnapshots.set(job.id, JSON.stringify(job));
	}

	jobOrder = JSON.stringify(result.map(job => job.id));

	return result;
}

function enqueue(operation) {
	const write = pendingWrites.then(operation);

	pendingWrites = write.catch(error => {
		console.error("History could not be saved", error);
		window.dispatchEvent(new CustomEvent("paws-storage-error", { detail: error }));
	});

	return write;
}

export function persistJobs(jobs) {
	const snapshot = jobs.map(job => JSON.stringify(job)),
		order = jobs.map(job => job.id),
		serializedOrder = JSON.stringify(order);

	return enqueue(async () => {
		const ids = new Set(order),
			changed = [];

		for (let index = 0; index < order.length; index++) {
			if (jobSnapshots.get(order[index]) !== snapshot[index]) {
				changed.push(JSON.parse(snapshot[index]));
			}
		}

		const removed = [...jobSnapshots.keys()].filter(id => !ids.has(id));

		await database.transaction("rw", database.jobs, database.settings, async () => {
			await database.jobs.bulkPut(changed);
			await database.jobs.bulkDelete(removed);

			if (jobOrder !== serializedOrder) {
				await database.settings.put({ key: "jobOrder", value: order });
			}
		});

		for (const job of changed) {
			jobSnapshots.set(job.id, JSON.stringify(job));
		}

		for (const id of removed) {
			jobSnapshots.delete(id);
		}

		jobOrder = serializedOrder;
		settings.set("jobOrder", order);

		scheduleCollection();
	});
}

export function load(key, fallback = false) {
	return settings.has(key) ? settings.get(key) : fallback;
}

export function store(key, value = false) {
	const snapshot = structuredClone(value);

	settings.set(key, snapshot);

	return enqueue(async () => {
		await database.settings.put({ key: key, value: snapshot });

		if (key === "referenceImages") {
			scheduleCollection();
		}
	});
}

export async function refresh(keys = []) {
	const result = new Map();

	await pendingWrites;

	for (const key of keys) {
		const row = await database.settings.get(key);

		settings.set(key, row?.value);
		result.set(key, row?.value ?? null);
	}

	return result;
}

export function retainAsset(id) {
	assetHolds.set(id, (assetHolds.get(id) || 0) + 1);

	let released = false;

	return () => {
		if (released) {
			return;
		}

		released = true;

		const count = assetHolds.get(id) - 1;

		if (count > 0) {
			assetHolds.set(id, count);
		} else {
			assetHolds.delete(id);
		}

		scheduleCollection();
	};
}

export function isAssetId(source) {
	return typeof source === "string" && source.length === 70 && /^asset:[a-f0-9]{64}$/.test(source);
}

export async function importAsset(source, signal, dimensions) {
	if (isAssetId(source)) {
		return source;
	}

	// Only inline image URLs may reach fetch; imports must never make network requests.
	if (!(source instanceof Blob) && (typeof source !== "string" || !/^data:image\/[a-zA-Z0-9.+-]+(?:;[^,]*)?,/.test(source))) {
		throw new TypeError("Expected an image file, image data URL, or asset ID");
	}

	const blob = source instanceof Blob ? source : await (await fetch(source, { signal: signal })).blob(),
		hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
		id = `asset:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("")}`;

	signal?.throwIfAborted();

	if (await database.assetInfo.get(id)) {
		return id;
	}

	const size = dimensions || await processBlob(blob, { inspect: true }, signal);

	signal?.throwIfAborted();

	await database.transaction("rw", database.assets, database.assetInfo, async () => {
		await database.assets.put({
			id: id,
			blob: blob,
		});

		await database.assetInfo.put({
			id: id,
			width: size.width,
			height: size.height,
			type: blob.type,
			bytes: blob.size,
			createdAt: Date.now(),
		});
	});

	scheduleCollection();

	return id;
}

export async function assetBlob(id) {
	const row = await database.assets.get(id);

	if (!row) {
		throw new Error(`Missing image asset: ${id}`);
	}

	return row.blob;
}

export function assetInfo(id) {
	return database.assetInfo.get(id);
}

export async function deriveAsset(id, options = {}, signal) {
	const release = retainAsset(id);

	try {
		signal?.throwIfAborted();

		const info = await assetInfo(id);

		signal?.throwIfAborted();

		const noEdits = !options.crop && !options.brightness && !options.contrast,
			fitsSize = !options.max || Math.max(info.width, info.height) <= options.max,
			matchesFormat = !options.format || options.format === info.type;

		if (noEdits && fitsSize && matchesFormat) {
			return id;
		}

		const crop = options.crop,
			format = options.format || info.type,
			rectangle = crop ? [crop.x, crop.y, crop.width, crop.height] : null,
			key = JSON.stringify([id, rectangle, options.brightness || 0, options.contrast || 0, options.max || 0, format]);

		return await shareDerivative(key, async sharedSignal => {
			const existing = await database.assetInfo.where("derivativeKey").equals(key).first();

			if (existing) {
				await database.assetInfo.update(existing.id, { lastUsed: Date.now() });

				return existing.id;
			}

			const result = await processBlob(await assetBlob(id), { ...options, format: format }, sharedSignal);

			sharedSignal.throwIfAborted();

			const derived = await importAsset(result.blob, sharedSignal, result);

			await database.assetInfo.update(derived, {
				derivativeKey: key,
				source: id,
				lastUsed: Date.now(),
			});

			return derived;
		}, signal);
	} finally {
		release();
	}
}

function shareDerivative(key, produce, signal) {
	signal?.throwIfAborted();

	let operation = pendingDerivatives.get(key);

	if (!operation) {
		operation = {
			controller: new AbortController(),
			users: 0
		};

		pendingDerivatives.set(key, operation);

		operation.promise = produce(operation.controller.signal).finally(() => {
			if (pendingDerivatives.get(key) === operation) {
				pendingDerivatives.delete(key);
			}
		});
	}

	operation.users++;

	return new Promise((resolve, reject) => {
		let done = false;

		const finish = (callback, value) => {
			if (done) {
				return;
			}

			done = true;

			signal?.removeEventListener("abort", abort);

			operation.users--;

			if (!operation.users && pendingDerivatives.get(key) === operation) {
				pendingDerivatives.delete(key);

				operation.controller.abort();
			}

			callback(value);
		};

		const abort = () => finish(reject, new DOMException("Aborted", "AbortError"));

		signal?.addEventListener("abort", abort, { once: true });

		operation.promise.then(value => finish(resolve, value), error => finish(reject, error));
	});
}

export async function thumbnail(id, max, signal, fit = "contain", purpose = "") {
	// Resizing replaces a purpose's cached thumbnail instead of accumulating size variants.
	const key = `${id}:${purpose}`,
		existing = purpose ? await database.thumbnails.get(key) : null;

	if (existing && existing.max === max && existing.fit === fit) {
		signal?.throwIfAborted();

		await database.thumbnails.update(key, { lastUsed: Date.now() });

		return existing;
	}

	let crop;

	if (fit === "cover") {
		const info = await assetInfo(id),
			edge = Math.min(info.width, info.height),
			width = edge / info.width,
			height = edge / info.height;

		crop = { x: (1 - width) / 2, y: (1 - height) / 2, width: width, height: height };
	}

	const result = await processBlob(await assetBlob(id), { crop: crop, max: max, format: "image/webp" }, signal);

	signal?.throwIfAborted();

	// Temporary views such as the image editor only need their in-memory preview.
	if (!purpose) {
		return result;
	}

	const record = {
		key: key,
		source: id,
		max: max,
		fit: fit,
		...result,
		bytes: result.blob.size,
		lastUsed: Date.now(),
	};

	await database.transaction("rw", database.assetInfo, database.thumbnails, async () => {
		const info = await database.assetInfo.get(id);

		signal?.throwIfAborted();

		if (!info) {
			return;
		}

		await database.thumbnails.put(record);

		const records = await database.thumbnails.orderBy("lastUsed").reverse().toArray(),
			removed = [];

		let bytes = 0;

		for (let index = 0; index < records.length; index++) {
			bytes += records[index].bytes;

			if (index >= MaxThumbnails || bytes > MaxThumbnailBytes) {
				removed.push(records[index].key);
			}
		}

		await database.thumbnails.bulkDelete(removed);
	});

	scheduleCollection();

	return record;
}

function scheduleCollection(delay = CollectionDelay) {
	if (migrating) {
		return;
	}

	const due = Date.now() + delay;

	if (collectionTimer && collectionDue <= due) {
		return;
	}

	clearTimeout(collectionTimer);

	collectionDue = due;
	collectionTimer = setTimeout(() => {
		collectionTimer = null;

		enqueue(collectAssets);
	}, delay);
}

async function collectAssets() {
	let nextCollection = Infinity;

	await database.transaction("rw", database.jobs, database.settings, database.assets, database.assetInfo, database.thumbnails, async () => {
		const live = new Set(assetHolds.keys()),
			previews = new Set(),
			referenceThumbnails = new Set(),
			references = (await database.settings.get("referenceImages"))?.value || [];

		for (const reference of references) {
			live.add(reference.original);
			live.add(reference.processed);
			previews.add(reference.processed || reference.original);
		}

		for (const job of await database.jobs.toArray()) {
			live.add(job.result);
			live.add(job.originalResult);
			previews.add(job.result);

			for (const id of job.payload.images || []) {
				live.add(id);
				referenceThumbnails.add(id);
			}
		}

		const dead = [],
			thumbnailKeys = new Set(),
			now = Date.now(),
			records = await database.assetInfo.toArray(),
			derivatives = records.filter(info => info.source && live.has(info.source) && !live.has(info.id)).sort((left, right) => right.lastUsed - left.lastUsed);

		let derivativeBytes = 0;

		for (let index = 0; index < derivatives.length; index++) {
			derivativeBytes += derivatives[index].bytes;

			if (index < MaxDerivatives && derivativeBytes <= MaxDerivativeBytes) {
				live.add(derivatives[index].id);
			}
		}

		for (const info of records) {
			// A grace period protects newly imported assets until their owner is committed.
			if (!live.has(info.id) && !assetHolds.has(info.id)) {
				const remaining = info.createdAt + AssetGracePeriod - now;

				if (remaining <= 0) {
					dead.push(info.id);
				} else {
					nextCollection = Math.min(nextCollection, remaining + CollectionDelay);
				}
			}

			if (previews.has(info.id)) {
				thumbnailKeys.add(`${info.id}:preview`);
			}

			if (referenceThumbnails.has(info.id)) {
				thumbnailKeys.add(`${info.id}:reference`);
			}
		}

		// Inspect keys only: obsolete sizes and orphaned thumbnails need no blob reads.
		const cachedKeys = await database.thumbnails.toCollection().primaryKeys(),
			obsolete = cachedKeys.filter(key => !thumbnailKeys.has(key));

		await database.assets.bulkDelete(dead);
		await database.assetInfo.bulkDelete(dead);
		await database.thumbnails.bulkDelete(obsolete);
	});

	if (Number.isFinite(nextCollection)) {
		scheduleCollection(nextCollection);
	}
}
