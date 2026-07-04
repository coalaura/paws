import "../css/paws.css";
import "../css/dropdown.css";

import { unpack } from "msgpackr";

import deleteSvg from "../css/icons/delete.svg?raw";
import downloadSvg from "../css/icons/download.svg?raw";
import editSvg from "../css/icons/edit.svg?raw";
import imageSvg from "../css/icons/image.svg?raw";
import moreSvg from "../css/icons/more.svg?raw";
import retrySvg from "../css/icons/retry.svg?raw";

import { dropdown } from "./dropdown.js";
import { connectDB, load, store } from "./storage.js";

const ChunkType = {
	0: "start",
	1: "image",
	2: "error",
	3: "end",
	4: "alive",
	5: "usage",
};

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
	$usageDisplay = document.getElementById("usage-display"),
	$maxRefResolution = document.getElementById("max-ref-resolution"),
	$presetSelect = document.getElementById("preset-select"),
	$savePresetBtn = document.getElementById("save-preset-btn"),
	$deletePresetBtn = document.getElementById("delete-preset-btn"),
	$savePresetModal = document.getElementById("save-preset-modal"),
	$savePresetError = document.getElementById("save-preset-error"),
	$presetNameInput = document.getElementById("preset-name-input"),
	$cancelSavePresetBtn = document.getElementById("cancel-save-preset-btn"),
	$confirmSavePresetBtn = document.getElementById("confirm-save-preset-btn"),
	$composerTabs = document.querySelectorAll(".composer-tab"),
	$systemDefaultToggle = document.getElementById("system-default-toggle");

await connectDB();

let rawRefs = load("referenceImages", []),
	referenceImages = rawRefs.map(item => (typeof item === "string" ? { original: item, processed: item } : item)),
	jobs = load("jobs", []),
	modelsData = [],
	currentUsageType = load("usageType", "daily"),
	currentUsageData = null,
	useDefaultSys = load("useDefaultSystem", false),
	resDropdown = null,
	presets = load("presets", load("settingsPresets", [])),
	presetOrder = load("presetOrder", []),
	activeComposerPane = load("activeComposerPane", "prompt"),
	activePresetName = "",
	unsavedPreset = null;

$useDefaultSystem.checked = useDefaultSys;

if (useDefaultSys) {
	$systemMessage.value = SystemPrompt;
	$systemMessage.disabled = true;
	$systemMessage.style.opacity = "0.5";
} else {
	$systemMessage.value = load("customSystem", load("system", ""));
	$systemMessage.style.opacity = "1";
}

$prompt.value = load("prompt", "");
$resolution.value = load("resolution", "2K");
$aspectRatio.value = load("aspect", "");
$maxRefResolution.value = load("maxRefResolution", "0");

updateResolutionEstimate();

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

function formatDuration(ms) {
	const totalSeconds = Math.floor(ms / 1000);

	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}

	const hours = Math.floor(totalSeconds / 3600),
		minutes = Math.floor((totalSeconds % 3600) / 60),
		seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}

	return `${minutes}m ${seconds}s`;
}

function calculateAspectRatio(width, height) {
	const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b)),
		d = gcd(width, height);

	return `${width / d}:${height / d}`;
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

function processRefImage(dataUrl) {
	return new Promise(resolve => {
		const maxRes = parseInt($maxRefResolution.value, 10) || 0,
			img = new Image();

		img.onload = () => {
			let width = img.naturalWidth,
				height = img.naturalHeight;

			if (maxRes > 0) {
				const maxDim = Math.max(width, height);

				if (maxDim > maxRes) {
					const scale = maxRes / maxDim;

					width = Math.round(width * scale);
					height = Math.round(height * scale);
				}
			}

			const canvas = document.createElement("canvas");

			canvas.width = width;
			canvas.height = height;

			const ctx = canvas.getContext("2d");

			ctx.drawImage(img, 0, 0, width, height);

			resolve(canvas.toDataURL("image/jpeg", 0.92));
		};

		img.src = dataUrl;
	});
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

function updateAvailableResolutions() {
	if (!resDropdown) {
		return;
	}

	const selectedModel = modelsData.find(mdl => mdl.id === $model.value);

	if (!selectedModel) {
		return;
	}

	const available = [];

	if (selectedModel.pricing?.image) {
		if (selectedModel.pricing.image.k_1 != null) {
			available.push("1K");
		}

		if (selectedModel.pricing.image.k_2 != null) {
			available.push("2K");
		}

		if (selectedModel.pricing.image.k_4 != null) {
			available.push("4K");
		}
	}

	if (available.length > 0) {
		resDropdown.setAvailable(available);
	} else {
		resDropdown.setAvailable(["1K", "2K", "4K"]);
	}

	updateResolutionEstimate();
}

function updateResolutionEstimate() {
	const res = $resolution.value,
		aspect = $aspectRatio.value;

	const $valSpan = document.getElementById("resolution-estimate-val");

	if (!$valSpan) {
		return;
	}

	let targetArea = 2048 * 2048; // default 2K

	if (res === "512") {
		targetArea = 512 * 512;
	} else if (res === "1K") {
		targetArea = 1024 * 1024;
	} else if (res === "2K") {
		targetArea = 2048 * 2048;
	} else if (res === "4K") {
		targetArea = 4096 * 4096;
	}

	let w, h;

	if (aspect) {
		const parts = aspect.split(":");

		if (parts.length === 2) {
			const wRatio = parseFloat(parts[0]),
				hRatio = parseFloat(parts[1]);

			if (!isNaN(wRatio) && !isNaN(hRatio) && wRatio > 0 && hRatio > 0) {
				h = Math.sqrt(targetArea * (hRatio / wRatio));
				w = h * (wRatio / hRatio);
			} else {
				w = Math.sqrt(targetArea);
				h = w;
			}
		} else {
			w = Math.sqrt(targetArea);
			h = w;
		}
	} else {
		w = Math.sqrt(targetArea);
		h = w;
	}

	let w64 = Math.round(w / 64) * 64,
		h64 = Math.round(h / 64) * 64;

	if (w64 < 64) {
		w64 = 64;
	}

	if (h64 < 64) {
		h64 = 64;
	}

	$valSpan.textContent = `${w64} × ${h64} px`;
}

function setComposerPane(pane, persist = true) {
	const nextPane = pane === "system" ? "system" : "prompt";

	$composerTabs.forEach(tab => {
		const isActive = tab.dataset.pane === nextPane;
		tab.classList.toggle("active", isActive);
		tab.setAttribute("aria-selected", isActive ? "true" : "false");
	});

	if (nextPane === "prompt") {
		$prompt.classList.remove("hidden");
		$systemMessage.classList.add("hidden");
		$systemDefaultToggle.classList.add("hidden");
	} else {
		$prompt.classList.add("hidden");
		$systemMessage.classList.remove("hidden");
		$systemDefaultToggle.classList.remove("hidden");
	}

	activeComposerPane = nextPane;

	if (persist) {
		store("activeComposerPane", nextPane);
	}
}

function renderReferenceImages() {
	$refImagesContainer.querySelectorAll(".ref-img-wrapper").forEach(el => el.remove());

	referenceImages.forEach((item, index) => {
		const wrapper = document.createElement("div");

		wrapper.className = "ref-img-wrapper";

		const img = document.createElement("img");

		img.src = item.processed || item.original;

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

		wrapper.draggable = true;
		wrapper.__refItem = item;

		wrapper.addEventListener("dragstart", event => {
			event.dataTransfer.setData("application/paws-ref-sort", "true");
			event.dataTransfer.effectAllowed = "move";

			setTimeout(() => wrapper.classList.add("dragging"), 0);
		});

		wrapper.addEventListener("dragend", () => {
			wrapper.classList.remove("dragging");

			const newImages = [];

			$refImagesContainer.querySelectorAll(".ref-img-wrapper").forEach(w => {
				if (w.__refItem) {
					newImages.push(w.__refItem);
				}
			});

			referenceImages.length = 0;
			referenceImages.push(...newImages);

			store("referenceImages", referenceImages);

			renderReferenceImages();
		});

		wrapper.addEventListener("dragover", event => {
			const types = Array.from(event.dataTransfer.types);

			if (!types.includes("application/paws-ref-sort")) {
				return;
			}

			event.preventDefault();
			event.dataTransfer.dropEffect = "move";

			const draggingNode = $refImagesContainer.querySelector(".dragging");

			if (!draggingNode || draggingNode === wrapper) {
				return;
			}

			const siblings = [...$refImagesContainer.querySelectorAll(".ref-img-wrapper")],
				draggingIndex = siblings.indexOf(draggingNode),
				targetIndex = siblings.indexOf(wrapper);

			if (draggingIndex < targetIndex) {
				wrapper.after(draggingNode);
			} else {
				wrapper.before(draggingNode);
			}
		});

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

		const dataUrl = await readFileAsDataUrl(file),
			processed = await processRefImage(dataUrl);

		referenceImages.push({ original: dataUrl, processed: processed });
	}

	renderReferenceImages();
}

async function useAsReference(job) {
	if (!job.result) {
		return;
	}

	if (referenceImages.length >= MaxImages) {
		console.warn("Maximum reference images reached");

		return;
	}

	const processed = await processRefImage(job.result);

	referenceImages.push({ original: job.result, processed: processed });

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

	if (payload.images && payload.images.length > 0) {
		const imagesToAdd = payload.images.slice(0, MaxImages);

		referenceImages.push(...imagesToAdd.map(img => ({ original: img, processed: img })));
	}

	renderReferenceImages();
	updateResolutionEstimate();
	syncPresetSelection();
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
	actions.appendChild(moreBtn);
	actions.appendChild(retryBtn);
	actions.appendChild(dlBtn);
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

	const selectedModel = modelsData.find(mdl => mdl.id === job.payload.model),
		modelName = selectedModel?.name || job.payload.model,
		modelAuthor = selectedModel?.author;

	const modelIndicator = document.createElement("div");

	modelIndicator.className = "job-model";

	if (modelAuthor) {
		const modelIcon = document.createElement("img");

		modelIcon.src = `/labs/${modelAuthor}.png`;
		modelIcon.className = "model-provider-icon";

		modelIndicator.appendChild(modelIcon);
	}

	const modelLabel = document.createElement("span");

	modelLabel.textContent = modelName;

	modelIndicator.appendChild(modelLabel);

	const timerBadge = document.createElement("span");

	timerBadge.className = "job-timer meta-timer";

	if (job.duration) {
		timerBadge.textContent = formatDuration(job.duration);
	} else if (job.startedAt && job.status === "pending") {
		timerBadge.textContent = formatDuration(Date.now() - job.startedAt);
	} else {
		timerBadge.classList.add("hidden");
	}

	modelIndicator.appendChild(timerBadge);

	const costBadge = document.createElement("span");

	costBadge.className = "cost-badge hidden";

	if (job.cost) {
		costBadge.textContent = formatMoney(job.cost);
		costBadge.classList.remove("hidden");
	}

	modelIndicator.appendChild(costBadge);

	meta.appendChild(modelIndicator);

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
		$cost: costBadge,
		$timer: timerBadge,
	};
}

function setupJobUI(ui, job, controller = null, clearTimer = null) {
	let isDone = job.status !== "pending";

	const cleanupActions = () => {
		isDone = true;

		ui.$spinner.classList.add("hidden");
		ui.retryBtn.classList.remove("hidden");
	};

	ui.closeBtn.addEventListener("click", () => {
		if (clearTimer) {
			clearTimer();
		}

		if (!isDone && controller) {
			controller.abort();
		}

		ui.card.remove();

		jobs = jobs.filter(jb => jb.id !== job.id);

		saveJobs();
	});

	ui.retryBtn.addEventListener("click", () => {
		if (clearTimer) {
			clearTimer();
		}

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

async function startGenerationJob(retryJob = null, replaceCard = null) {
	let job;

	if (retryJob) {
		job = retryJob;

		job.status = "pending";
		job.result = null;
		job.error = null;
		job.cost = null;
		job.startedAt = Date.now();
		job.duration = null;
	} else {
		const payload = {
			model: $model.value,
			system: $systemMessage.value.trim(),
			prompt: $prompt.value.trim(),
			images: referenceImages.map(img => img.processed || img),
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
			startedAt: Date.now(),
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
		startTime = job.startedAt;

	const timerInterval = setInterval(() => {
		ui.$timer.textContent = formatDuration(Date.now() - startTime);
		ui.$timer.classList.remove("hidden");
	}, 1000);

	ui.$timer.textContent = formatDuration(0);
	ui.$timer.classList.remove("hidden");

	const clearTimer = () => {
		clearInterval(timerInterval);
	};

	const cleanupActions = setupJobUI(ui, job, controller, clearTimer);

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

				clearTimer();

				job.duration = Date.now() - startTime;

				ui.$timer.textContent = formatDuration(job.duration);

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

					clearTimer();

					job.duration = Date.now() - startTime;

					ui.$timer.textContent = formatDuration(job.duration);

					ui.$img.classList.remove("blurred");
					ui.dlBtn.classList.remove("hidden");

					job.status = "done";

					saveJobs();

					fetchUsage();

					break;
				case "error":
					cleanupActions();

					clearTimer();

					job.duration = Date.now() - startTime;

					ui.$timer.textContent = formatDuration(job.duration);

					ui.card.classList.add("errored");

					ui.$error.textContent = chunk.data;
					ui.$error.classList.remove("hidden");

					job.status = "errored";
					job.error = chunk.data;

					saveJobs();

					break;
				case "usage":
					job.cost = chunk.data;

					ui.$cost.textContent = formatMoney(chunk.data);
					ui.$cost.classList.remove("hidden");

					saveJobs();

					break;
			}
		}
	);
}

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
			modelsData = data.models;

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

		updateAvailableResolutions();
	} catch (err) {
		console.error("Failed to load data:", err);

		dropdown($model);
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

$addRefBtn.addEventListener("click", () => {
	$fileInput.click();
});

$fileInput.addEventListener("change", event => {
	handleFiles(event.target.files);

	$fileInput.value = "";
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

	const types = Array.from(event.dataTransfer.types);

	if (types.includes("application/paws-ref-index")) {
		return;
	}

	const data = event.dataTransfer.getData("text/plain");

	if (data?.startsWith("data:image")) {
		if (referenceImages.length < MaxImages) {
			const processed = await processRefImage(data);

			referenceImages.push({
				original: data,
				processed: processed,
			});

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

let isApplyingPreset = false;

$composerTabs.forEach(tab => {
	tab.addEventListener("click", () => {
		setComposerPane(tab.dataset.pane);
	});
});

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

	if (!isApplyingPreset) {
		syncPresetSelection();
	}
});

$systemMessage.addEventListener("input", () => {
	if (!useDefaultSys) {
		store("customSystem", $systemMessage.value);
		store("system", $systemMessage.value);
	}

	if (!isApplyingPreset) {
		syncPresetSelection();
	}
});

$prompt.addEventListener("input", () => {
	store("prompt", $prompt.value);

	if (!isApplyingPreset) {
		syncPresetSelection();
	}
});

$prompt.addEventListener("keydown", event => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();

		startGenerationJob();
	}
});

$model.addEventListener("change", () => {
	store("model", $model.value);

	updateAvailableResolutions();

	if (!isApplyingPreset) {
		syncPresetSelection();
	}
});

$resolution.addEventListener("change", () => {
	store("resolution", $resolution.value);

	updateResolutionEstimate();
});

$aspectRatio.addEventListener("change", () => {
	store("aspect", $aspectRatio.value);

	updateResolutionEstimate();
});

$maxRefResolution.addEventListener("change", async () => {
	store("maxRefResolution", $maxRefResolution.value);

	if (referenceImages.length > 0) {
		for (const referenceImage of referenceImages) {
			referenceImage.processed = await processRefImage(referenceImage.original);
		}

		renderReferenceImages();
	}
});

$generateBtn.addEventListener("click", () => startGenerationJob());

$imageModal.querySelector(".background").addEventListener("click", () => {
	$imageModal.classList.remove("open");
});

$closeImageModal.addEventListener("click", () => {
	$imageModal.classList.remove("open");
});

resDropdown = dropdown($resolution);

dropdown($aspectRatio);
dropdown($maxRefResolution);

if (referenceImages.length > 0) {
	renderReferenceImages();
}

await loadData();

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

function sortPresetsByOrder(list = []) {
	const orderMap = new Map(presetOrder.map((name, index) => [name, index]));

	return [...list].sort((a, b) => {
		const aIdx = orderMap.has(a.name) ? orderMap.get(a.name) : Number.MAX_SAFE_INTEGER,
			bIdx = orderMap.has(b.name) ? orderMap.get(b.name) : Number.MAX_SAFE_INTEGER;

		if (aIdx !== bIdx) {
			return aIdx - bIdx;
		}

		return a.name.localeCompare(b.name);
	});
}

function snapshotCurrentPresetState(name = "") {
	return {
		name: name,
		model: $model.value,
		prompt: $prompt.value.trim(),
		system: useDefaultSys ? $systemMessage.value.trim() : $systemMessage.value.trim() || "",
		useDefaultSystem: useDefaultSys,
	};
}

function renderPresets(selectedName = "") {
	$presetSelect.innerHTML = '<option value="" disabled selected>Load Preset...</option>';

	if (unsavedPreset) {
		const unsavedOption = document.createElement("option");

		unsavedOption.value = "__preset__";
		unsavedOption.textContent = "unsaved*";

		$presetSelect.appendChild(unsavedOption);
	}

	sortPresetsByOrder(presets).forEach(preset => {
		const option = document.createElement("option");

		option.value = preset.name;
		option.textContent = preset.name;

		$presetSelect.appendChild(option);
	});

	if (selectedName) {
		$presetSelect.value = selectedName;
		$deletePresetBtn.disabled = selectedName === "__preset__";
	} else {
		$presetSelect.value = "";
		$deletePresetBtn.disabled = true;
	}

	const existingDropdown = $presetSelect.nextElementSibling;

	if (existingDropdown?.classList.contains("dropdown")) {
		existingDropdown.remove();
	}

	dropdown($presetSelect);
}

function applyPreset(preset) {
	if (!preset) {
		return;
	}

	isApplyingPreset = true;

	try {
		if (preset.model) {
			$model.value = preset.model;

			store("model", preset.model);

			$model.dispatchEvent(new Event("change"));
		}

		if (preset.useDefaultSystem !== undefined) {
			$useDefaultSystem.checked = preset.useDefaultSystem;

			useDefaultSys = preset.useDefaultSystem;

			store("useDefaultSystem", useDefaultSys);

			if (useDefaultSys) {
				$systemMessage.value = SystemPrompt;
				$systemMessage.disabled = true;
				$systemMessage.style.opacity = "0.5";

				store("system", SystemPrompt);
			} else {
				const customSys = preset.system || "";

				$systemMessage.value = customSys;
				$systemMessage.disabled = false;
				$systemMessage.style.opacity = "1";

				store("customSystem", customSys);
				store("system", customSys);
			}
		}

		if (preset.prompt !== undefined) {
			$prompt.value = preset.prompt;

			store("prompt", preset.prompt);
		}
	} finally {
		isApplyingPreset = false;
	}
}

function findMatchingPreset() {
	const current = snapshotCurrentPresetState();

	return presets.find(preset =>
		preset.model === current.model &&
		preset.prompt === current.prompt &&
		preset.system === current.system &&
		preset.useDefaultSystem === current.useDefaultSystem
	);
}

function syncPresetSelection() {
	if (!$presetSelect) {
		return;
	}

	const match = findMatchingPreset();

	if (match) {
		activePresetName = match.name;

		$presetSelect.value = match.name;

		if ($deletePresetBtn) {
			$deletePresetBtn.disabled = false;
		}

		return;
	}

	activePresetName = "";

	$presetSelect.value = "";

	if ($deletePresetBtn) {
		$deletePresetBtn.disabled = true;
	}
}

$presetSelect.addEventListener("favorite", event => {
	presetOrder = event.detail;

	store("presetOrder", presetOrder);
});

$presetSelect.addEventListener("change", () => {
	const selectedName = $presetSelect.value;

	if (selectedName) {
		if (selectedName === "__preset__") {
			applyPreset(unsavedPreset);

			activePresetName = "";
			unsavedPreset = null;

			renderPresets("");

			return;
		}

		if (selectedName !== "__preset__" && !activePresetName) {
			unsavedPreset = snapshotCurrentPresetState("unsaved*");
		}

		const preset = selectedName === "__preset__" ? unsavedPreset : presets.find(p => p.name === selectedName);

		applyPreset(preset);

		activePresetName = selectedName;

		$deletePresetBtn.disabled = selectedName === "__preset__";
	} else {
		activePresetName = "";

		$deletePresetBtn.disabled = true;
	}

	renderPresets(selectedName);
});

$savePresetBtn.addEventListener("click", () => {
	const selectedPresetName = $presetSelect.value === "__preset__" ? "" : $presetSelect.value;

	$presetNameInput.value = selectedPresetName || "";

	$savePresetError.textContent = "";
	$savePresetModal.classList.remove("errored");

	const exists = presets.some(p => p.name.toLowerCase() === $presetNameInput.value.trim().toLowerCase());

	$confirmSavePresetBtn.textContent = exists ? "Override" : "Save";

	$savePresetModal.classList.add("open");

	$presetNameInput.focus();
});

$presetNameInput.addEventListener("input", () => {
	const name = $presetNameInput.value.trim(),
		exists = presets.some(p => p.name.toLowerCase() === name.toLowerCase());

	$confirmSavePresetBtn.textContent = exists ? "Override" : "Save";

	$savePresetModal.classList.remove("errored");
	$savePresetError.textContent = "";
});

$cancelSavePresetBtn.addEventListener("click", () => {
	$savePresetModal.classList.remove("open");
});

$savePresetModal.querySelector(".background").addEventListener("click", () => {
	$savePresetModal.classList.remove("open");
});

$confirmSavePresetBtn.addEventListener("click", () => {
	const name = $presetNameInput.value.trim();

	if (!name) {
		$savePresetError.textContent = "Please enter a preset name.";

		$savePresetModal.classList.add("errored");

		return;
	}

	const currentSetup = snapshotCurrentPresetState(name);

	const existingIndex = presets.findIndex(p => p.name.toLowerCase() === name.toLowerCase());

	if (existingIndex > -1) {
		const previousName = presets[existingIndex].name;

		presets[existingIndex] = currentSetup;

		if (previousName !== name) {
			presetOrder = presetOrder.map(orderName => (orderName === previousName ? name : orderName));
		}
	} else {
		presets.push(currentSetup);

		if (!presetOrder.includes(name)) {
			presetOrder.push(name);
		}
	}

	store("presets", presets);
	store("settingsPresets", presets);
	store("presetOrder", presetOrder);

	activePresetName = name;

	renderPresets(name);

	$savePresetModal.classList.remove("open");
});

$deletePresetBtn.addEventListener("click", () => {
	const selectedName = $presetSelect.value;

	if (!selectedName) {
		return;
	}

	if (confirm(`Are you sure you want to delete "${selectedName}"?`)) {
		presets = presets.filter(p => p.name !== selectedName);
		presetOrder = presetOrder.filter(name => name !== selectedName);

		store("presets", presets);
		store("settingsPresets", presets);
		store("presetOrder", presetOrder);

		activePresetName = "";

		renderPresets("");
	}
});

document.addEventListener("keydown", event => {
	if (event.key === "Escape") {
		if ($savePresetModal?.classList.contains("open")) {
			$savePresetModal.classList.remove("open");
		}

		if ($imageModal?.classList.contains("open")) {
			$imageModal.classList.remove("open");
		}
	}
});

renderPresets();

syncPresetSelection();

setComposerPane(activeComposerPane, false);

fetchUsage();

$loader.remove();
