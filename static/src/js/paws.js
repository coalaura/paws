import "../css/paws.css";
import "../css/dropdown.css";

import deleteSvg from "../css/icons/delete.svg?raw";
import downloadSvg from "../css/icons/download.svg?raw";
import retrySvg from "../css/icons/retry.svg?raw";
import moreSvg from "../css/icons/more.svg?raw";
import imageSvg from "../css/icons/image.svg?raw";
import editSvg from "../css/icons/edit.svg?raw";

import { unpack } from "msgpackr";

import { dropdown } from "./dropdown.js";
import { connectDB, load, store } from "./storage.js";

await connectDB();

const ChunkType = {
	0: "start",
	1: "image",
	2: "error",
	3: "end",
	4: "alive",
};

const $loader = document.getElementById("global-loader"),
	$systemMessage = document.getElementById("system-message"),
	$useDefaultSystem = document.getElementById("use-default-system"),
	$prompt = document.getElementById("prompt"),
	$refImagesContainer = document.getElementById("reference-images"),
	$addRefBtn = document.getElementById("add-ref-btn"),
	$fileInput = document.getElementById("file-input"),
	$refCount = document.getElementById("ref-count"),
	$generateBtn = document.getElementById("generate-btn"),
	$grid = document.getElementById("grid"),
	$model = document.getElementById("model"),
	$resolution = document.getElementById("resolution"),
	$aspectRatio = document.getElementById("aspect-ratio"),
	$authentication = document.getElementById("authentication"),
	$authError = document.getElementById("auth-error"),
	$username = document.getElementById("username"),
	$password = document.getElementById("password"),
	$login = document.getElementById("login"),
	$imageModal = document.getElementById("image-modal"),
	$fullImage = document.getElementById("full-image"),
	$closeImageModal = document.getElementById("close-image-modal"),
	$usageDisplay = document.getElementById("usage-display");

let referenceImages = load("referenceImages", []),
	jobs = load("jobs", []),
	currentUsageType = load("usageType", "daily"),
	currentUsageData = null,
	useDefaultSys = load("useDefaultSystem", false);

const MaxImages = 4,
	UsageTypes = ["daily", "weekly", "monthly", "total"],
	UsageLabels = {
		daily: { short: "D", tooltip: "Usage today" },
		weekly: { short: "W", tooltip: "Usage this week" },
		monthly: { short: "M", tooltip: "Usage this month" },
		total: { short: "T", tooltip: "Total usage" },
	};

const SystemPrompt = `You are an expert image generation model. Produce exactly what the user describes in their prompt with maximum visual fidelity, detail, and technical quality.

Reference images, if provided, serve as authoritative visual context. Use them for subject identity, style, composition, lighting, or materials as implied by the prompt. When the prompt references "the image," "this character," etc., resolve those to the supplied references.

Rules:
- Follow the prompt literally and precisely; do not reinterpret, censor, or soften intent.
- Do not add unrequested elements, text, watermarks, signatures, borders, or stylistic flourishes.
- Preserve requested aspect ratio, framing, and subject placement.
- Prioritize sharpness, accurate anatomy, coherent lighting, and clean details over artistic embellishment.`;

$useDefaultSystem.checked = useDefaultSys;

if (useDefaultSys) {
	$systemMessage.value = SystemPrompt;
	$systemMessage.disabled = true;
	$systemMessage.style.opacity = "0.5";
} else {
	$systemMessage.value = load("customSystem", load("system", ""));
}

$usageDisplay.addEventListener("click", event => {
	if (event.button === 0) {
		const idx = UsageTypes.indexOf(currentUsageType);

		currentUsageType = UsageTypes[(idx + 1) % UsageTypes.length];

		store("usageType", currentUsageType);

		updateUsageDisplay();
	}
});

$usageDisplay.addEventListener("auxclick", event => {
	if (event.button === 1) {
		fetchUsage();
	}
});

async function fetchUsage() {
	try {
		const res = await fetch("/-/usage");

		if (res.ok) {
			currentUsageData = await res.json();

			updateUsageDisplay();
		}
	} catch (err) {
		console.error("Failed to fetch usage", err);
	}
}

function updateUsageDisplay() {
	if (!currentUsageData) {
		return;
	}

	const val = currentUsageData[currentUsageType] || 0,
		label = UsageLabels[currentUsageType];

	$usageDisplay.textContent = `${label.short} / ${formatMoney(val)}`;
	$usageDisplay.title = `Paws: ${label.tooltip}`;
}

export function fixed(num, decimals = 0) {
	return num.toFixed(decimals).replace(/\.?0+$/m, "");
}

export function formatMoney(num) {
	if (num === 0) {
		return "0ct";
	}

	if (num < 1) {
		let decimals = 1;

		if (num < 0.00001) {
			decimals = 4;
		} else if (num < 0.0001) {
			decimals = 3;
		} else if (num < 0.001) {
			decimals = 2;
		}

		return `${fixed(num * 100, decimals)}ct`;
	}

	return `$${fixed(num, 2)}`;
}

function saveJobs() {
	store("jobs", jobs);
}

function openImageModal(src) {
	$fullImage.src = src;

	$imageModal.classList.add("open");
}
function readFileAsDataUrl(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();

		reader.onload = () => resolve(reader.result);
		reader.onerror = reject;

		reader.readAsDataURL(file);
	});
}

async function stream(url, options, callback) {
	let aborted;

	try {
		const response = await fetch(url, options);

		if (!response.ok) {
			const err = await response.json().catch(() => null);

			throw new Error(err?.error || response.statusText);
		}

		const reader = response.body.getReader();

		let buffer = new Uint8Array();

		while (true) {
			const { value, done } = await reader.read();

			if (done) {
				break;
			}

			const read = new Uint8Array(buffer.length + value.length);

			read.set(buffer);
			read.set(value, buffer.length);

			buffer = read;

			while (buffer.length >= 5) {
				const type = ChunkType[buffer[0]],
					length = buffer[1] | (buffer[2] << 8) | (buffer[3] << 16) | (buffer[4] << 24);

				if (!type) {
					console.warn("bad chunk type", type);

					buffer = buffer.slice(5 + length);

					continue;
				}

				if (buffer.length < 5 + length) {
					break;
				}

				let data;

				if (length > 0) {
					const packed = buffer.slice(5, 5 + length);

					try {
						data = unpack(packed);
					} catch (err) {
						console.warn("bad chunk data", packed, err);
					}
				}

				buffer = buffer.slice(5 + length);

				if (type === "alive") {
					continue;
				}

				callback({
					type: type,
					data: data,
				});
			}
		}
	} catch (err) {
		if (err.name === "AbortError") {
			aborted = true;

			return;
		}

		console.error(err);

		callback({
			type: "error",
			data: err.message,
		});
	} finally {
		callback(aborted ? "aborted" : "done");
	}
}

async function loadData() {
	try {
		const response = await fetch("/-/data");

		if (!response.ok) {
			throw new Error(response.statusText);
		}

		const data = await response.json();

		if (data.auth && !data.authenticated) {
			$authentication.classList.add("open");

			return;
		}

		$model.innerHTML = "";

		const existingDropdown = $model.nextElementSibling;

		if (existingDropdown?.classList.contains("dropdown")) {
			existingDropdown.remove();
		}

		if (data.models && data.models.length > 0) {
			for (const model of data.models) {
				const option = document.createElement("option");

				option.value = model.id;
				option.textContent = model.name;

				if (model.author) {
					option.dataset.icon = `/labs/${model.author}.png`;
				}

				if (model.pricing?.image) {
					const { k_1, k_2, k_4 } = model.pricing.image;

					const getPriceClass = price => {
						if (price > 0.12) {
							return "expensive";
						}

						if (price <= 0) {
							return "free";
						}

						if (price <= 0.08) {
							return "cheap";
						}

						return "normal";
					};

					const prices = [];

					if (k_1 != null) {
						prices.push(`<span class="price-badge ${getPriceClass(k_1)}">1K: ${formatMoney(k_1)}</span>`);
					}

					if (k_2 != null) {
						prices.push(`<span class="price-badge ${getPriceClass(k_2)}">2K: ${formatMoney(k_2)}</span>`);
					}

					if (k_4 != null) {
						prices.push(`<span class="price-badge ${getPriceClass(k_4)}">4K: ${formatMoney(k_4)}</span>`);
					}

					if (prices.length > 0) {
						option.dataset.prices = prices.join("");
					}
				}

				$model.appendChild(option);
			}
		}

		const savedModel = load("model");

		if (savedModel) {
			$model.value = savedModel;
		}

		const favorites = load("favorites", []);

		dropdown($model, favorites);

		$model.addEventListener("favorite", event => {
			store("favorites", event.detail);
		});
	} catch (err) {
		dropdown($model);

		console.error("Failed to load data:", err);
	}
}

async function login() {
	const username = $username.value.trim(),
		password = $password.value.trim();

	if (!username || !password) {
		throw new Error("missing username or password");
	}

	const data = await fetch("/-/auth", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			username: username,
			password: password,
		}),
	}).then(response => response.json());

	if (!data?.authenticated) {
		throw new Error(data.error || "authentication failed");
	}
}

$login.addEventListener("click", async () => {
	$authentication.classList.remove("errored");
	$authentication.classList.add("loading");

	try {
		await login();

		$authentication.classList.remove("open");

		await loadData();

		fetchUsage();
	} catch (err) {
		console.error(err);

		$authError.textContent = `Error: ${err.message}`;

		$authentication.classList.add("errored");

		$password.value = "";
	}

	$authentication.classList.remove("loading");
});

$username.addEventListener("input", () => {
	$authentication.classList.remove("errored");
});

$password.addEventListener("input", () => {
	$authentication.classList.remove("errored");
});

await loadData();

fetchUsage();

$refImagesContainer.setAttribute("data-total", "1");

function renderReferenceImages() {
	$refImagesContainer.querySelectorAll(".ref-img-wrapper").forEach(el => el.remove());

	referenceImages.forEach((dataUrl, index) => {
		const wrapper = document.createElement("div");

		wrapper.className = "ref-img-wrapper";

		const img = document.createElement("img");

		img.src = dataUrl;

		wrapper.appendChild(img);

		const rmBtn = document.createElement("button");

		rmBtn.className = "rm-ref-btn";
		rmBtn.innerHTML = "&times;";
		rmBtn.title = "Remove image";

		rmBtn.addEventListener("click", () => {
			referenceImages.splice(index, 1);

			renderReferenceImages();
		});

		wrapper.appendChild(rmBtn);

		$refImagesContainer.insertBefore(wrapper, $addRefBtn);
	});

	$refCount.textContent = `(${referenceImages.length}/${MaxImages})`;

	const canAdd = referenceImages.length < MaxImages;

	$addRefBtn.classList.toggle("hidden", !canAdd);

	const totalElements = referenceImages.length + (canAdd ? 1 : 0);

	$refImagesContainer.setAttribute("data-total", totalElements);

	store("referenceImages", referenceImages);
}

async function handleFiles(files) {
	for (const file of files) {
		if (referenceImages.length >= MaxImages) {
			break;
		}

		if (!file.type.startsWith("image/")) {
			continue;
		}

		const dataUrl = await readFileAsDataUrl(file);

		referenceImages.push(dataUrl);
	}

	renderReferenceImages();
}

$addRefBtn.addEventListener("click", () => {
	$fileInput.click();
});

$fileInput.addEventListener("change", event => {
	handleFiles(event.target.files);

	$fileInput.value = ""; // reset
});

$refImagesContainer.addEventListener("dragover", event => {
	event.preventDefault();

	event.dataTransfer.dropEffect = "copy";

	$refImagesContainer.classList.add("drag-over");
});

$refImagesContainer.addEventListener("dragleave", event => {
	if (!$refImagesContainer.contains(event.relatedTarget)) {
		$refImagesContainer.classList.remove("drag-over");
	}
});

$refImagesContainer.addEventListener("drop", async event => {
	event.preventDefault();

	$refImagesContainer.classList.remove("drag-over");

	const data = event.dataTransfer.getData("text/plain");

	if (data?.startsWith("data:image")) {
		if (referenceImages.length < MaxImages) {
			referenceImages.push(data);

			renderReferenceImages();
		}

		return;
	}

	const files = event.dataTransfer.files;

	if (files.length > 0) {
		await handleFiles(files);
	}
});

$prompt.addEventListener("paste", async event => {
	const items = event.clipboardData?.items;

	if (!items) {
		return;
	}

	const imageFiles = [];

	for (const item of items) {
		if (item.type.startsWith("image/")) {
			imageFiles.push(item.getAsFile());
		}
	}

	if (imageFiles.length > 0) {
		event.preventDefault();

		await handleFiles(imageFiles);
	}
});

function calculateAspectRatio(w, h) {
	const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b)),
		d = gcd(w, h);

	return `${w / d}:${h / d}`;
}

function createJobDOM(job) {
	const card = document.createElement("div"),
		promptText = job.payload.prompt;

	card.className = "job-card";

	if (job.status === "errored") {
		card.classList.add("errored");
	}

	const imgContainer = document.createElement("div");

	imgContainer.className = "job-image-container";

	const img = document.createElement("img");

	img.className = "result-image";

	if (job.status !== "done" && !job.result) {
		img.classList.add("blurred", "hidden");
	} else if (job.result) {
		img.src = job.result;

		if (job.status === "done") {
			img.draggable = true;
		} else {
			img.classList.add("blurred");
		}
	}

	const spinner = document.createElement("div");

	spinner.className = "spinner";

	if (job.status !== "pending") {
		spinner.classList.add("hidden");
	}

	const actions = document.createElement("div");

	actions.className = "job-actions";

	const closeBtn = document.createElement("button");

	closeBtn.className = "action-btn close-btn";
	closeBtn.innerHTML = deleteSvg;
	closeBtn.title = "Cancel / Remove";

	const dlBtn = document.createElement("button");

	dlBtn.className = "action-btn";

	if (job.status !== "done") {
		dlBtn.classList.add("hidden");
	}

	dlBtn.innerHTML = downloadSvg;
	dlBtn.title = "Download";

	const retryBtn = document.createElement("button");

	retryBtn.className = "action-btn";

	if (job.status === "pending") {
		retryBtn.classList.add("hidden");
	}

	retryBtn.innerHTML = retrySvg;
	retryBtn.title = "Retry";

	const moreBtn = document.createElement("button");

	moreBtn.className = "action-btn more-btn";
	moreBtn.innerHTML = moreSvg;
	moreBtn.title = "More actions";

	const menu = document.createElement("div");

	menu.className = "job-menu";

	const useRefItem = document.createElement("div");

	useRefItem.className = "job-menu-item";
	useRefItem.innerHTML = `${imageSvg} Use as Reference`;

	if (!job.result) {
		useRefItem.style.opacity = "0.5";
		useRefItem.style.pointerEvents = "none";
	}

	const loadSettingsItem = document.createElement("div");

	loadSettingsItem.className = "job-menu-item";
	loadSettingsItem.innerHTML = `${editSvg} Load Settings`;

	menu.appendChild(useRefItem);
	menu.appendChild(loadSettingsItem);

	actions.appendChild(closeBtn);
	actions.appendChild(retryBtn);
	actions.appendChild(dlBtn);
	actions.appendChild(moreBtn);
	actions.appendChild(menu);

	imgContainer.appendChild(img);
	imgContainer.appendChild(spinner);
	imgContainer.appendChild(actions);

	const specs = document.createElement("div");

	specs.className = "job-specs";

	const resolution = job.payload.image?.resolution;

	if (resolution) {
		const resBadge = document.createElement("span");

		resBadge.className = "spec-badge";
		resBadge.textContent = resolution;

		specs.appendChild(resBadge);
	}

	const aspectBadge = document.createElement("span");

	aspectBadge.className = "spec-badge hidden";

	specs.appendChild(aspectBadge);

	img.addEventListener("load", () => {
		if (img.naturalWidth && img.naturalHeight) {
			aspectBadge.textContent = calculateAspectRatio(img.naturalWidth, img.naturalHeight);

			aspectBadge.classList.remove("hidden");
		}
	});

	imgContainer.appendChild(specs);

	const meta = document.createElement("div");

	meta.className = "job-meta";

	const refs = job.payload.images || [];

	if (refs.length > 0) {
		const refsDiv = document.createElement("div");

		refsDiv.className = "job-refs";

		for (const src of refs) {
			const refImg = document.createElement("img");

			refImg.src = src;

			refImg.addEventListener("click", event => {
				event.stopPropagation();

				openImageModal(src);
			});

			refsDiv.appendChild(refImg);
		}

		meta.appendChild(refsDiv);
	}

	const promptDiv = document.createElement("div");

	promptDiv.className = "job-prompt";
	promptDiv.title = promptText || "";

	if (promptText) {
		promptDiv.textContent = promptText;
	} else {
		const italic = document.createElement("i");

		italic.textContent = "No prompt provided";

		promptDiv.appendChild(italic);
	}

	const errorDiv = document.createElement("div");

	errorDiv.className = "job-error";

	if (job.status !== "errored") {
		errorDiv.classList.add("hidden");
	}

	if (job.error) {
		errorDiv.textContent = job.error;
	}

	meta.appendChild(promptDiv);
	meta.appendChild(errorDiv);

	card.appendChild(imgContainer);
	card.appendChild(meta);

	return {
		card: card,
		closeBtn: closeBtn,
		dlBtn: dlBtn,
		retryBtn: retryBtn,
		moreBtn: moreBtn,
		menu: menu,
		useRefItem: useRefItem,
		loadSettingsItem: loadSettingsItem,
		$img: img,
		$spinner: spinner,
		$error: errorDiv,
	};
}

function useAsReference(job) {
	if (!job.result) {
		return;
	}

	if (referenceImages.length >= MaxImages) {
		console.warn("Maximum reference images reached");

		return;
	}

	referenceImages.push(job.result);

	renderReferenceImages();
}

function loadSettings(job) {
	if (!job.payload) {
		return;
	}

	const payload = job.payload;

	if (payload.model) {
		$model.value = payload.model;

		store("model", payload.model);
	}

	if (payload.image?.resolution) {
		$resolution.value = payload.image.resolution;

		store("resolution", payload.image.resolution);
	}

	if (payload.image?.aspect) {
		$aspectRatio.value = payload.image.aspect;

		store("aspect", payload.image.aspect);
	}

	if (payload.system !== undefined) {
		if (payload.system === SystemPrompt) {
			$useDefaultSystem.checked = true;

			$systemMessage.disabled = true;
			$systemMessage.style.opacity = "0.5";

			useDefaultSys = true;

			store("useDefaultSystem", true);

			$systemMessage.value = SystemPrompt;

			store("system", SystemPrompt);
		} else {
			$useDefaultSystem.checked = false;

			$systemMessage.disabled = false;
			$systemMessage.style.opacity = "1";

			useDefaultSys = false;

			store("useDefaultSystem", false);

			$systemMessage.value = payload.system;

			store("customSystem", payload.system);
			store("system", payload.system);
		}
	}

	if (payload.prompt !== undefined) {
		$prompt.value = payload.prompt;

		store("prompt", payload.prompt);
	}

	referenceImages = [];

	console.log(payload.images.length);

	if (payload.images && payload.images.length > 0) {
		const imagesToAdd = payload.images.slice(0, MaxImages);

		referenceImages.push(...imagesToAdd);
	}

	renderReferenceImages();
}

function setupJobUI(ui, job, controller = null) {
	let isDone = job.status !== "pending";

	const cleanupActions = () => {
		isDone = true;

		ui.$spinner.classList.add("hidden");
		ui.retryBtn.classList.remove("hidden");
	};

	ui.closeBtn.addEventListener("click", () => {
		if (!isDone && controller) {
			controller.abort();
		}

		ui.card.remove();

		jobs = jobs.filter(jb => jb.id !== job.id);

		saveJobs();
	});

	ui.retryBtn.addEventListener("click", () => {
		if (!isDone && controller) {
			controller.abort();
		}

		startGenerationJob(job, ui.card);
	});

	ui.dlBtn.addEventListener("click", () => {
		if (!ui.$img.src) {
			return;
		}

		const a = document.createElement("a");

		a.href = ui.$img.src;
		a.download = `p${Date.now().toString(16)}.png`;

		a.click();
	});

	ui.$img.addEventListener("click", () => {
		if (isDone && ui.$img.src && typeof openImageModal === "function") {
			openImageModal(ui.$img.src);
		}
	});

	ui.moreBtn.addEventListener("click", event => {
		event.stopPropagation();

		document.querySelectorAll(".job-menu.open").forEach(mnu => {
			if (mnu !== ui.menu) {
				mnu.classList.remove("open");

				mnu.closest(".job-card")?.classList.remove("menu-open");
			}
		});

		ui.menu.classList.toggle("open");
		ui.card.classList.toggle("menu-open", ui.menu.classList.contains("open"));
	});

	ui.useRefItem.addEventListener("click", () => {
		useAsReference(job);

		ui.menu.classList.remove("open");
		ui.card.classList.remove("menu-open");
	});

	ui.loadSettingsItem.addEventListener("click", () => {
		loadSettings(job);

		ui.menu.classList.remove("open");
		ui.card.classList.remove("menu-open");
	});

	ui.$img.addEventListener("dragstart", event => {
		if (!isDone || !job.result) {
			event.preventDefault();

			return;
		}

		event.dataTransfer.setData("text/plain", job.result);
		event.dataTransfer.effectAllowed = "copy";
	});

	return cleanupActions;
}

async function startGenerationJob(retryJob = null, replaceCard = null) {
	let job;

	if (retryJob) {
		job = retryJob;

		job.status = "pending";
		job.result = null;
		job.error = null;
	} else {
		const payload = {
			model: $model.value,
			system: $systemMessage.value.trim(),
			prompt: $prompt.value.trim(),
			images: [...referenceImages],
			image: {
				resolution: $resolution.value,
				aspect: $aspectRatio.value,
			},
		};

		if (!payload.system && !payload.prompt && payload.images.length === 0) {
			return;
		}

		job = {
			id: Date.now().toString() + Math.random().toString(36).substring(2),
			payload: payload,
			status: "pending",
			result: null,
			error: null,
		};

		jobs.unshift(job);
	}

	saveJobs();

	const ui = createJobDOM(job);

	if (replaceCard?.parentNode) {
		replaceCard.replaceWith(ui.card);
	} else {
		$grid.prepend(ui.card);
	}

	const controller = new AbortController(),
		cleanupActions = setupJobUI(ui, job, controller);

	stream(
		"/-/image",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(job.payload),
			signal: controller.signal,
		},
		chunk => {
			if (chunk === "done" || chunk === "aborted") {
				cleanupActions();

				ui.$img.classList.remove("blurred");

				if (chunk === "done" && !ui.$img.classList.contains("hidden")) {
					ui.dlBtn.classList.remove("hidden");

					job.status = "done";

					saveJobs();

					fetchUsage();
				} else if (chunk === "aborted") {
					job.status = "errored";
					job.error = "Aborted";

					ui.$error.textContent = job.error;
					ui.$error.classList.remove("hidden");

					ui.card.classList.add("errored");

					saveJobs();
				}

				return;
			}

			switch (chunk.type) {
				case "image":
					ui.$img.src = chunk.data;
					ui.$img.classList.remove("hidden");

					job.result = chunk.data;

					if (ui.useRefItem) {
						ui.useRefItem.style.opacity = "1";
						ui.useRefItem.style.pointerEvents = "auto";
					}

					ui.$img.draggable = true;

					saveJobs();

					break;
				case "end":
					cleanupActions();

					ui.$img.classList.remove("blurred");
					ui.dlBtn.classList.remove("hidden");

					job.status = "done";

					saveJobs();

					fetchUsage();

					break;
				case "error":
					cleanupActions();

					ui.card.classList.add("errored");

					ui.$error.textContent = chunk.data;
					ui.$error.classList.remove("hidden");

					job.status = "errored";
					job.error = chunk.data;

					saveJobs();

					break;
			}
		}
	);
}

$useDefaultSystem.addEventListener("change", event => {
	useDefaultSys = event.target.checked;

	store("useDefaultSystem", useDefaultSys);

	if (useDefaultSys) {
		if ($systemMessage.value !== SystemPrompt && $systemMessage.value.trim() !== "") {
			store("customSystem", $systemMessage.value);
		}

		$systemMessage.value = SystemPrompt;
		$systemMessage.disabled = true;
		$systemMessage.style.opacity = "0.5";
	} else {
		$systemMessage.value = load("customSystem", "");
		$systemMessage.disabled = false;
		$systemMessage.style.opacity = "1";
	}

	store("system", $systemMessage.value);
});

$systemMessage.addEventListener("input", () => {
	if (!useDefaultSys) {
		store("customSystem", $systemMessage.value);

		store("system", $systemMessage.value);
	}
});

$prompt.value = load("prompt", "");

$prompt.addEventListener("input", () => {
	store("prompt", $prompt.value);
});

$model.addEventListener("change", () => {
	store("model", $model.value);
});

$resolution.addEventListener("change", () => {
	store("resolution", $resolution.value);
});

$aspectRatio.addEventListener("change", () => {
	store("aspect", $aspectRatio.value);
});

$generateBtn.addEventListener("click", () => startGenerationJob());

$imageModal.querySelector(".background").addEventListener("click", () => {
	$imageModal.classList.remove("open");
});

$closeImageModal.addEventListener("click", () => {
	$imageModal.classList.remove("open");
});

$prompt.addEventListener("keydown", event => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();

		startGenerationJob();
	}
});

dropdown($resolution);
dropdown($aspectRatio);

const savedRes = load("resolution");

if (savedRes) {
	$resolution.value = savedRes;
}

const savedAspect = load("aspect");

if (savedAspect) {
	$aspectRatio.value = savedAspect;
}

if (referenceImages.length > 0) {
	renderReferenceImages();
}

for (let i = jobs.length - 1; i >= 0; i--) {
	const job = jobs[i];

	if (job.status === "pending") {
		job.status = "errored";
		job.error = "Aborted (page reload)";
	}

	const ui = createJobDOM(job);

	$grid.prepend(ui.card);

	setupJobUI(ui, job);
}

$loader.remove();
