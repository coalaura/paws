import "../css/paws.css";
import "../css/dropdown.css";

import deleteSvg from "../css/icons/delete.svg?raw";
import downloadSvg from "../css/icons/download.svg?raw";
import editSvg from "../css/icons/edit.svg?raw";
import imageSvg from "../css/icons/image.svg?raw";
import compareSvg from "../css/icons/compare.svg?raw";
import copySvg from "../css/icons/copy.svg?raw";
import moveSvg from "../css/icons/move.svg?raw";
import pinSvg from "../css/icons/pin.svg?raw";
import retrySvg from "../css/icons/retry.svg?raw";

import { dropdown } from "./dropdown.js";
import { Gallery } from "./gallery.js";
import { bindImage, bindResponsiveImage, releaseImage, releaseImages, acquireImage, imageDataURL } from "./image-assets.js";
import { stream } from "./image-stream.js";
import { adjustImageTones } from "./image-transform.js";
import { connectDB, load, store, loadJobs, persistJobs, importAsset, isAssetId, deriveAsset, assetInfo, retainAsset } from "./storage.js";

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
	$appVersion = document.getElementById("app-version"),
	$refImagesContainer = document.getElementById("reference-images"),
	$addRefBtn = document.getElementById("add-ref-btn"),
	$fileInput = document.getElementById("file-input"),
	$refCount = document.getElementById("ref-count"),
	$generateBtn = document.getElementById("generate-btn"),
	$grid = document.getElementById("grid"),
	$model = document.getElementById("model"),
	$resolution = document.getElementById("resolution"),
	$aspectRatio = document.getElementById("aspect-ratio"),
	$quality = document.getElementById("quality"),
	$authentication = document.getElementById("authentication"),
	$authError = document.getElementById("auth-error"),
	$username = document.getElementById("username"),
	$password = document.getElementById("password"),
	$login = document.getElementById("login"),
	$imageModal = document.getElementById("image-modal"),
	$fullImage = document.getElementById("full-image"),
	$imageZoom = document.getElementById("image-zoom"),
	$zoomImage = document.getElementById("zoom-image"),
	$closeImageModal = document.getElementById("close-image-modal"),
	$cropModal = document.getElementById("crop-modal"),
	$cropStage = document.getElementById("crop-stage"),
	$cropImage = document.getElementById("crop-image"),
	$cropSelection = document.getElementById("crop-selection"),
	$cropTitle = document.getElementById("crop-title"),
	$cropBrightness = document.getElementById("crop-brightness"),
	$cropContrast = document.getElementById("crop-contrast"),
	$cropBrightnessValue = document.getElementById("crop-brightness-value"),
	$cropContrastValue = document.getElementById("crop-contrast-value"),
	$closeCropModal = document.getElementById("close-crop-modal"),
	$resetCropBtn = document.getElementById("reset-crop-btn"),
	$applyCropBtn = document.getElementById("apply-crop-btn"),
	$resizeModal = document.getElementById("resize-modal"),
	$resizeForm = document.getElementById("resize-form"),
	$resizeWidth = document.getElementById("resize-width"),
	$resizeHeight = document.getElementById("resize-height"),
	$resizePercent = document.getElementById("resize-percent"),
	$resizePercentValue = document.getElementById("resize-percent-value"),
	$resizeError = document.getElementById("resize-error"),
	$cancelResizeBtn = document.getElementById("cancel-resize-btn"),
	$applyResizeBtn = document.getElementById("apply-resize-btn"),
	$comparisonModal = document.getElementById("comparison-modal"),
	$comparisonBefore = document.getElementById("comparison-before"),
	$comparisonAfter = document.getElementById("comparison-after"),
	$comparisonBeforeClip = document.getElementById("comparison-before-clip"),
	$comparisonDivider = document.getElementById("comparison-divider"),
	$comparisonRange = document.getElementById("comparison-range"),
	$comparisonReferencePicker = document.getElementById("comparison-reference-picker"),
	$comparisonReferenceSelect = document.getElementById("comparison-reference-select"),
	$closeComparisonModal = document.getElementById("close-comparison-modal"),
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

try {
	await connectDB();
} catch (error) {
	$loader.textContent = `Could not load history: ${error.message}. History has not been cleared. Reload to retry.`;

	throw error;
}

const executions = new Map(),
	referenceSizeCache = new WeakMap();

let referenceImages = load("referenceImages", []),
	jobs = await loadJobs(),
	modelsData = [],
	currentUsageType = load("usageType", "daily"),
	currentUsageData = null,
	useDefaultSys = load("useDefaultSystem", false),
	resDropdown = null,
	aspectDropdown = null,
	qualityDropdown = null,
	presets = load("presets", load("settingsPresets", [])),
	presetOrder = load("presetOrder", []),
	activeComposerPane = load("activeComposerPane", "prompt"),
	activePresetName = "",
	unsavedPreset = null,
	pageDragDepth = 0,
	imageZoomPointerId = null,
	cropItem = null,
	cropJob = null,
	cropSession = 0,
	cropController = null,
	cropSourceImage = null,
	cropPreviewFrame = 0,
	crop = null,
	cropDrag = null,
	resizeState = null,
	draggedImageSource = null,
	draggedJobCard = null,
	releaseDrag = null,
	costEstimateSeq = 0,
	costEstimateTimer = null,
	costEstimateController = null,
	gallery = null;

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
$aspectRatio.value = load("aspect", "auto") || "auto";
$quality.value = load("quality", "auto");
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
	document.title = jobs.some(job => job.status === "pending") ? `paws *` : "paws";

	persistJobs(jobs).catch(reportStorageError);

	gallery?.schedule();
}

function reportStorageError(error) {
	$loader.textContent = `Could not save history: ${error.message}. Keep this page open and free browser storage before retrying.`;
	$loader.classList.remove("hidden");
}

window.addEventListener("paws-storage-error", event => reportStorageError(event.detail));

function clearJobDrag() {
	draggedJobCard?.classList.remove("reordering");
	draggedJobCard = null;
}

function closeJobMenus() {
	document.querySelectorAll(".job-menu.open").forEach(menu => {
		menu.classList.remove("open");

		menu.closest(".job-card")?.classList.remove("menu-open");
	});
}

$grid.addEventListener("dragover", event => {
	if (!draggedJobCard) {
		return;
	}

	event.preventDefault();
	event.dataTransfer.dropEffect = "move";

	const target = event.target.closest(".job-card");

	if (!target || target === draggedJobCard) {
		return;
	}

	const rect = target.getBoundingClientRect(),
		columns = $grid.clientWidth > rect.width * 1.5,
		before = columns ? event.clientX < rect.left + rect.width / 2 : event.clientY < rect.top + rect.height / 2;

	const sourceIndex = jobs.findIndex(job => job.id === draggedJobCard.dataset.jobId),
		targetJob = jobs.find(job => job.id === target.dataset.jobId),
		[moved] = jobs.splice(sourceIndex, 1),
		targetIndex = jobs.indexOf(targetJob);

	jobs.splice(targetIndex + (before ? 0 : 1), 0, moved);

	gallery.render();
});

$grid.addEventListener("drop", event => {
	if (!draggedJobCard) {
		return;
	}

	event.preventDefault();
	event.stopPropagation();

	finishJobDrag();
});

function finishJobDrag() {
	if (!draggedJobCard) {
		return;
	}

	saveJobs();
	clearJobDrag();
}

$grid.addEventListener("dragend", finishJobDrag);

document.addEventListener("click", event => {
	if (!event.target.closest(".job-menu")) {
		closeJobMenus();
	}
});

$grid.parentElement.addEventListener("scroll", closeJobMenus);

async function addReferenceImage(source) {
	if (!source || referenceImages.length >= MaxImages) {
		return;
	}

	const id = await importAsset(source);

	if (referenceImages.length < MaxImages) {
		referenceImages.push({
			original: id,
			processed: id
		});

		renderReferenceImages();
	}
}

async function openResizeModal(item, trigger) {
	closeResizeModal();

	const state = {
		item: item,
		trigger: trigger,
		controller: new AbortController(),
		width: 0,
		height: 0,
		max: 0
	};

	resizeState = state;

	$resizeModal.classList.add("open", "loading");
	$resizeWidth.value = "";
	$resizeHeight.value = "";
	$resizeWidth.disabled = true;
	$resizeHeight.disabled = true;
	$resizePercent.disabled = true;
	$resizePercentValue.value = "";
	$applyResizeBtn.disabled = true;

	$cancelResizeBtn.focus();

	try {
		const [original, current] = await Promise.all([assetInfo(item.original), assetInfo(item.processed || item.original)]);

		if (resizeState !== state) {
			return;
		}

		state.width = Math.max(1, Math.round(original.width * (item.crop?.width || 1)));
		state.height = Math.max(1, Math.round(original.height * (item.crop?.height || 1)));
		state.max = Math.max(current.width, current.height);

		$resizeWidth.max = state.width;
		$resizeHeight.max = state.height;
		$resizeWidth.value = current.width;
		$resizeHeight.value = current.height;
		$resizeWidth.disabled = false;
		$resizeHeight.disabled = false;
		$resizePercent.disabled = false;
		$applyResizeBtn.disabled = false;

		updateResizePercentage();

		$resizeWidth.focus();
		$resizeWidth.select();
	} catch (error) {
		if (resizeState === state) {
			$resizeError.textContent = "Could not load the image dimensions. Close and try again.";
			$resizeModal.classList.add("errored");
		}
	} finally {
		if (resizeState === state) {
			$resizeModal.classList.remove("loading");
		}
	}
}

function closeResizeModal() {
	const trigger = resizeState?.trigger;

	resizeState?.controller.abort();
	resizeState = null;

	$resizeModal.classList.remove("open", "loading", "errored");

	trigger?.focus();
}

function updateResizeDimensions(input) {
	if (!resizeState || !resizeState.width || !input.validity.valid) {
		$applyResizeBtn.disabled = true;

		return;
	}

	const longest = Math.max(resizeState.width, resizeState.height),
		dimension = input === $resizeWidth ? resizeState.width : resizeState.height;

	resizeState.max = clamp(Math.round(input.valueAsNumber * longest / dimension), 1, longest);

	const scale = resizeState.max / longest;

	$resizeWidth.value = Math.max(1, Math.round(resizeState.width * scale));
	$resizeHeight.value = Math.max(1, Math.round(resizeState.height * scale));
	$applyResizeBtn.disabled = false;
	$resizeModal.classList.remove("errored");

	updateResizePercentage();
}

function updateResizePercentage() {
	const percent = resizeState.max / Math.max(resizeState.width, resizeState.height) * 100;

	$resizePercent.value = clamp(Math.round(percent), 1, 100);
	$resizePercentValue.value = `${Number(percent.toFixed(1))}%`;
	$resizePercent.style.setProperty("--resize-progress", `${($resizePercent.valueAsNumber - 1) / 99 * 100}%`);
}

function applyResizePercentage() {
	if (!resizeState || !resizeState.width || $resizePercent.disabled) {
		return;
	}

	const longest = Math.max(resizeState.width, resizeState.height),
		input = resizeState.width >= resizeState.height ? $resizeWidth : $resizeHeight;

	input.value = Math.max(1, Math.round(longest * $resizePercent.valueAsNumber / 100));

	updateResizeDimensions(input);
}

async function downloadReferenceImage(item, index) {
	const source = item.processed || item.original,
		lease = acquireImage(source);

	try {
		const [url, info] = await Promise.all([lease.url, assetInfo(source)]),
			link = document.createElement("a");

		link.href = url;
		link.download = `reference-${index + 1}.${info.type.split("/")[1] || "png"}`;

		link.click();
	} catch (error) {
		console.error("Failed to download reference image", error);

		alert("Could not download the reference image.");
	} finally {
		setTimeout(() => lease.release(), 1000);
	}
}

function openImageModal(id) {
	stopImageZoom();

	bindImage($fullImage, id);
	bindImage($zoomImage, id);

	$imageModal.classList.add("open");
}

function stopImageZoom() {
	if (imageZoomPointerId === null) {
		return;
	}

	const pointerId = imageZoomPointerId;

	imageZoomPointerId = null;

	$imageZoom.classList.add("hidden");

	if ($fullImage.hasPointerCapture(pointerId)) {
		$fullImage.releasePointerCapture(pointerId);
	}
}

function closeImageModal() {
	stopImageZoom();

	$imageModal.classList.remove("open");

	releaseImage($fullImage);
	releaseImage($zoomImage);
}

function updateImageZoom(event) {
	const bounds = $fullImage.getBoundingClientRect(),
		zoomWidth = $imageZoom.clientWidth,
		zoomHeight = $imageZoom.clientHeight,
		zoom = 2,
		imageWidth = bounds.width * zoom,
		imageHeight = bounds.height * zoom,
		sourceX = clamp(event.clientX - bounds.left, 0, bounds.width),
		sourceY = clamp(event.clientY - bounds.top, 0, bounds.height);

	$zoomImage.style.width = `${imageWidth}px`;
	$zoomImage.style.height = `${imageHeight}px`;
	$zoomImage.style.left = `${clamp(zoomWidth / 2 - sourceX * zoom, zoomWidth - imageWidth, 0)}px`;
	$zoomImage.style.top = `${clamp(zoomHeight / 2 - sourceY * zoom, zoomHeight - imageHeight, 0)}px`;

	$imageZoom.style.left = `${event.clientX - $imageZoom.offsetWidth / 2}px`;
	$imageZoom.style.top = `${event.clientY - $imageZoom.offsetHeight / 2}px`;
}

function clamp(value, min, max) {
	return Math.min(Math.max(value, min), max);
}

function renderCropSelection() {
	if (!crop) {
		return;
	}

	$cropSelection.style.left = `${crop.x * 100}%`;
	$cropSelection.style.top = `${crop.y * 100}%`;
	$cropSelection.style.width = `${crop.width * 100}%`;
	$cropSelection.style.height = `${crop.height * 100}%`;
}

function updateCropAdjustments() {
	$cropBrightnessValue.value = $cropBrightness.value;
	$cropContrastValue.value = $cropContrast.value;
}

function renderCropPreview() {
	if (!cropSourceImage?.complete || !cropSourceImage.naturalWidth) {
		return;
	}

	const brightness = Number($cropBrightness.value),
		contrast = Number($cropContrast.value);

	const scale = Math.min(1, 1000 / Math.max(cropSourceImage.naturalWidth, cropSourceImage.naturalHeight)),
		canvas = $cropImage;

	canvas.width = Math.max(1, Math.round(cropSourceImage.naturalWidth * scale));
	canvas.height = Math.max(1, Math.round(cropSourceImage.naturalHeight * scale));

	const context = canvas.getContext("2d");

	context.drawImage(cropSourceImage, 0, 0, canvas.width, canvas.height);

	adjustImageTones(context, canvas.width, canvas.height, brightness, contrast);
}

function openCropModal(item, isGeneration = false) {
	closeCropModal();

	cropController = new AbortController();
	cropItem = isGeneration ? null : item;
	cropJob = isGeneration ? item : null;

	crop = item.crop ? { ...item.crop } : { x: 0, y: 0, width: 1, height: 1 };

	$cropBrightness.value = item.brightness || 0;
	$cropContrast.value = item.contrast || 0;
	$cropTitle.textContent = isGeneration ? "Edit Generation" : "Edit Reference";

	updateCropAdjustments();

	const source = new Image();

	cropSourceImage = source;

	source.onload = () => {
		if (cropSourceImage === source) {
			renderCropPreview();
			renderCropSelection();
		}
	};

	bindImage(source, isGeneration ? item.originalResult || item.result : item.original, 1000);
	$cropModal.classList.add("open");

	requestAnimationFrame(renderCropSelection);
}

function closeCropModal() {
	cropSession++;
	cropController?.abort();
	cropController = null;

	if (cropSourceImage) {
		releaseImage(cropSourceImage);
	}

	$cropImage.width = 1;
	$cropImage.height = 1;
	$applyCropBtn.disabled = false;

	$cropModal.classList.remove("loading");
	$cropModal.classList.remove("open");

	cropItem = null;
	cropJob = null;
	cropSourceImage = null;

	cancelAnimationFrame(cropPreviewFrame);

	crop = null;
	cropDrag = null;
}

function updateComparisonPosition() {
	const position = $comparisonRange.value;

	$comparisonBeforeClip.style.clipPath = `inset(0 ${100 - position}% 0 0)`;
	$comparisonDivider.style.left = `${position}%`;
}

function openComparisonModal(job) {
	const refs = job.payload?.images || [];

	if (!job.result || refs.length === 0) {
		return;
	}

	$comparisonReferenceSelect.nextElementSibling?.remove();
	$comparisonReferenceSelect.style.display = "";
	$comparisonReferenceSelect.replaceChildren();

	refs.forEach((src, index) => {
		const option = document.createElement("option");

		option.value = src;
		option.textContent = `Reference ${index + 1}`;

		$comparisonReferenceSelect.appendChild(option);
	});

	dropdown($comparisonReferenceSelect);

	$comparisonReferencePicker.classList.toggle("hidden", refs.length < 2);

	bindImage($comparisonAfter, job.result);
	bindImage($comparisonBefore, refs[0]);

	$comparisonRange.value = 50;

	updateComparisonPosition();

	$comparisonModal.classList.add("open");
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

function updateAvailableOptions() {
	if (!resDropdown || !aspectDropdown || !qualityDropdown) {
		return;
	}

	const selectedModel = modelsData.find(mdl => mdl.id === $model.value);

	if (!selectedModel) {
		return;
	}

	const options = selectedModel.options || {},
		resolutions = options.resolutions?.length ? options.resolutions : ["1K"],
		qualities = options.qualities?.length ? options.qualities : ["auto"];

	const aspectRatios = [
		"auto",
		...(Array.isArray(options.aspect_ratios) ? options.aspect_ratios.filter((ratio) => ratio !== "auto") : []),
	];

	resDropdown = extendEstimateOptions($resolution, resolutions, resDropdown);
	aspectDropdown = extendEstimateOptions($aspectRatio, aspectRatios, aspectDropdown);
	qualityDropdown = extendEstimateOptions($quality, qualities, qualityDropdown);

	resDropdown.setAvailable(resolutions);
	aspectDropdown.setAvailable(aspectRatios);
	qualityDropdown.setAvailable(qualities);

	store("resolution", $resolution.value);
	store("aspect", $aspectRatio.value);
	store("quality", $quality.value);

	updateResolutionEstimate();
}

function extendEstimateOptions(select, values, current) {
	const missing = values.filter(value => !Array.from(select.options).some(option => option.value === value));

	if (!missing.length) {
		return current;
	}

	for (const value of missing) {
		select.add(new Option(value, value));
	}

	return dropdown(select);
}

function updateResolutionEstimate() {
	const $costSpan = document.getElementById("resolution-estimate-cost"),
		seq = ++costEstimateSeq;

	clearTimeout(costEstimateTimer);
	costEstimateController?.abort();

	if (!$costSpan) {
		return;
	}

	if (!$model.value) {
		setCostEstimate($costSpan, "idle", "select a model");

		return;
	}

	setCostEstimate($costSpan, "loading", "calculating...");

	costEstimateTimer = setTimeout(() => fetchCostEstimate($costSpan, seq), 250);
}

async function referenceImageSize(item, max) {
	const source = item.processed || item.original;

	let cached = referenceSizeCache.get(item);

	if (cached?.source !== source) {
		cached = { source, promise: assetInfo(source) };

		referenceSizeCache.set(item, cached);
	}

	try {
		const info = await cached.promise;

		if (!info || !Number.isFinite(info.width) || !Number.isFinite(info.height) || info.width <= 0 || info.height <= 0) {
			throw new Error(`Missing image dimensions: ${source}`);
		}

		const scale = max > 0 ? Math.min(1, max / Math.max(info.width, info.height)) : 1;

		return {
			width: Math.max(1, Math.round(info.width * scale)),
			height: Math.max(1, Math.round(info.height * scale)),
		};
	} catch (error) {
		if (referenceSizeCache.get(item) === cached) {
			referenceSizeCache.delete(item);
		}

		throw error;
	}
}

async function fetchCostEstimate($costSpan, seq) {
	const request = {
		model: $model.value,
		quality: $quality.value,
		aspect: $aspectRatio.value,
		resolution: $resolution.value,
		prompt: $prompt.value,
		system: $systemMessage.value,
	};

	if (!request.model || seq !== costEstimateSeq) {
		return;
	}

	const controller = new AbortController();
	costEstimateController = controller;

	try {
		const max = Number($maxRefResolution.value),
			references = await Promise.all(referenceImages.map(item => referenceImageSize(item, max)));

		if (seq !== costEstimateSeq) {
			return;
		}

		const response = await fetch("/-/cost", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...request, references }),
			signal: controller.signal,
		});

		const data = await response.json();

		if (seq !== costEstimateSeq) {
			return;
		}

		const available = response.ok && data.available !== false && Number.isFinite(data.estimate) && data.estimate >= 0;

		const title = [
			data.source === "fallback" ? "Fallback estimate." : "Estimated cost for one image.",
			...(data.notes || []),
			data.error || "",
		].filter(Boolean).join("\n");

		if (available) {
			const range = Number.isFinite(data.maximum) && data.maximum > data.estimate
				? `–${formatMoney(data.maximum)}`
				: "";

			setCostEstimate($costSpan, "ready", `~${formatMoney(data.estimate)}${range}`, title);
		} else {
			setCostEstimate($costSpan, "unavailable", "unavailable", title);
		}
	} catch (error) {
		if (error.name !== "AbortError") {
			console.error("Failed to fetch cost estimate", error);
		}

		if (seq === costEstimateSeq) {
			setCostEstimate($costSpan, "unavailable", "unavailable", "Could not fetch the cost estimate.");
		}
	}
}

function setCostEstimate($costSpan, state, text, title = "") {
	$costSpan.dataset.state = state;
	$costSpan.textContent = text;
	$costSpan.title = title;
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
	releaseImages($refImagesContainer);

	$refImagesContainer.querySelectorAll(".ref-img-wrapper").forEach(el => el.remove());

	referenceImages.forEach((item, index) => {
		const wrapper = document.createElement("div");

		wrapper.className = "ref-img-wrapper";

		const img = document.createElement("img");

		bindResponsiveImage(img, item.processed || item.original);

		wrapper.appendChild(img);

		const actions = document.createElement("div"),
			editBtn = document.createElement("button"),
			downloadBtn = document.createElement("button"),
			downloadIcon = document.createElement("span"),
			resizeBtn = document.createElement("button");

		actions.className = "ref-actions";
		editBtn.className = "ref-control edit-ref-btn";
		editBtn.textContent = "Edit";
		editBtn.title = "Crop and adjust image";
		editBtn.addEventListener("pointerdown", event => event.stopPropagation());
		editBtn.addEventListener("click", () => openCropModal(item));

		downloadBtn.className = "ref-control download-ref-btn";
		downloadBtn.title = "Download reference image";
		downloadBtn.setAttribute("aria-label", "Download reference image");
		downloadIcon.className = "download-ref-icon";
		downloadIcon.setAttribute("aria-hidden", "true");

		downloadBtn.append(downloadIcon);

		downloadBtn.addEventListener("pointerdown", event => event.stopPropagation());
		downloadBtn.addEventListener("click", () => downloadReferenceImage(item, index));

		resizeBtn.className = "ref-control resize-ref-btn";
		resizeBtn.textContent = "...";
		resizeBtn.title = "Resize reference image";
		resizeBtn.setAttribute("aria-label", "Resize reference image");

		resizeBtn.addEventListener("pointerdown", event => event.stopPropagation());
		resizeBtn.addEventListener("click", () => openResizeModal(item, resizeBtn));

		assetInfo(item.processed || item.original).then(info => {
			resizeBtn.textContent = `${info.width}x${info.height}`;
			resizeBtn.setAttribute("aria-label", `Resize reference image, ${info.width} by ${info.height} pixels`);
			resizeBtn.disabled = false;
		}).catch(error => {
			resizeBtn.textContent = "Unavailable";
			resizeBtn.disabled = true;

			console.error("Failed to load reference dimensions", error);
		});

		actions.append(editBtn, downloadBtn);
		wrapper.append(actions, resizeBtn);

		const rmBtn = document.createElement("button");

		rmBtn.className = "rm-ref-btn";
		rmBtn.innerHTML = "&times;";
		rmBtn.title = "Remove image";

		rmBtn.addEventListener("click", () => {
			if (cropItem === item) {
				closeCropModal();
			}

			if (resizeState?.item === item) {
				closeResizeModal();
			}

			referenceImages.splice(index, 1);

			renderReferenceImages();
		});

		wrapper.appendChild(rmBtn);

		wrapper.draggable = true;
		wrapper.__refItem = item;

		wrapper.addEventListener("dragstart", event => {
			startAssetDrag(event, item.processed || item.original);

			event.dataTransfer.setData("application/paws-ref-sort", "true");
			event.dataTransfer.setData("application/paws-reference-image", "reference");
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

	updateResolutionEstimate();
}

async function handleFiles(files) {
	for (const file of files) {
		if (referenceImages.length >= MaxImages) {
			break;
		}

		if (!file.type.startsWith("image/")) {
			continue;
		}

		await addReferenceImage(file);
	}

	renderReferenceImages();
}

async function useAsReference(job) {
	if (!job.result || referenceImages.length >= MaxImages) {
		console.warn("Maximum reference images reached");

		return;
	}

	await addReferenceImage(job.result);
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

	if (payload.image?.quality) {
		$quality.value = payload.image.quality;

		store("quality", payload.image.quality);
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

	updateAvailableOptions();

	referenceImages = [];

	if (payload.images && payload.images.length > 0) {
		const imagesToAdd = payload.images.slice(0, MaxImages);

		referenceImages.push(...imagesToAdd.map(img => ({ original: img, processed: img })));
	}

	renderReferenceImages();
	syncPresetSelection(true);
}

function createJobDOM(job) {
	const card = document.createElement("div"),
		promptText = job.payload.prompt;

	card.className = "job-card";
	card.dataset.jobId = job.id;
	card.classList.toggle("pinned", Boolean(job.pinned));

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
		bindResponsiveImage(img, job.result);

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

	const pinBtn = document.createElement("button");

	pinBtn.className = "job-menu-item pin-menu-item";
	pinBtn.type = "button";
	pinBtn.innerHTML = `${pinSvg}<span>${job.pinned ? "Unpin generation" : "Pin generation"}</span>`;
	pinBtn.title = job.pinned ? "Unpin generation" : "Pin generation";
	pinBtn.classList.toggle("active", Boolean(job.pinned));
	pinBtn.setAttribute("aria-pressed", String(Boolean(job.pinned)));

	const pinnedBadge = document.createElement("div");

	pinnedBadge.className = "job-pinned-badge";
	pinnedBadge.innerHTML = pinSvg;
	pinnedBadge.title = "Pinned generation";
	pinnedBadge.classList.toggle("hidden", !job.pinned);

	const moveIndicator = document.createElement("span");

	moveIndicator.className = "move-indicator";
	moveIndicator.innerHTML = moveSvg;
	moveIndicator.setAttribute("aria-hidden", "true");

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

	const menu = document.createElement("div");

	menu.className = "job-menu";
	const useRefItem = document.createElement("button");

	const refs = job.payload.images || [];

	useRefItem.className = "job-menu-item";
	useRefItem.innerHTML = `${imageSvg} Use as Reference`;
	useRefItem.type = "button";

	if (!job.result) {
		useRefItem.disabled = true;
	}

	const compareItem = document.createElement("button");

	compareItem.className = "job-menu-item";
	compareItem.innerHTML = `${compareSvg} Compare Before / After`;
	compareItem.type = "button";

	if (!job.result || refs.length === 0) {
		compareItem.disabled = true;
	}

	const editImageItem = document.createElement("button");

	editImageItem.className = "job-menu-item";
	editImageItem.innerHTML = `${editSvg} Crop / Adjust Image`;
	editImageItem.type = "button";
	editImageItem.disabled = job.status !== "done";

	const loadSettingsItem = document.createElement("button");

	loadSettingsItem.className = "job-menu-item";
	loadSettingsItem.innerHTML = `${editSvg} Load Settings`;
	loadSettingsItem.type = "button";

	const copyPromptItem = document.createElement("button");

	copyPromptItem.className = "job-menu-item";
	copyPromptItem.innerHTML = `${copySvg} Copy Entire Prompt`;
	copyPromptItem.type = "button";

	const promptHeading = document.createElement("div"),
		imageHeading = document.createElement("div");

	promptHeading.className = "job-menu-heading";
	promptHeading.textContent = "Prompt";
	imageHeading.className = "job-menu-heading";
	imageHeading.textContent = "Image";

	menu.appendChild(pinBtn);
	menu.appendChild(promptHeading);
	menu.appendChild(loadSettingsItem);
	menu.appendChild(copyPromptItem);
	menu.appendChild(imageHeading);
	menu.appendChild(editImageItem);
	menu.appendChild(useRefItem);
	menu.appendChild(compareItem);

	actions.appendChild(closeBtn);
	actions.appendChild(retryBtn);
	actions.appendChild(dlBtn);

	imgContainer.appendChild(img);
	imgContainer.appendChild(spinner);
	imgContainer.appendChild(actions);
	imgContainer.appendChild(pinnedBadge);

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

	const quality = job.payload.image?.quality;

	if (quality) {
		const qualityBadge = document.createElement("span");

		qualityBadge.className = "spec-badge";
		qualityBadge.textContent = quality;

		specs.appendChild(qualityBadge);
	}

	if (job.result) {
		assetInfo(job.result).then(info => {
			if (info && card.isConnected) {
				aspectBadge.textContent = calculateAspectRatio(info.width, info.height);
				aspectBadge.classList.remove("hidden");
			}
		});
	}

	imgContainer.appendChild(specs);

	const meta = document.createElement("div");

	meta.className = "job-meta";
	meta.draggable = true;

	if (refs.length > 0) {
		const refsDiv = document.createElement("div");

		refsDiv.className = "job-refs";

		for (const src of refs) {
			const refImg = document.createElement("img");

			bindImage(refImg, src, Math.ceil(24 * devicePixelRatio * 1.5 / 64) * 64, "cover", "reference");

			refImg.draggable = true;

			refImg.addEventListener("dragstart", event => {
				startAssetDrag(event, src);

				event.dataTransfer.setData("application/paws-reference-image", "reference");
				event.dataTransfer.effectAllowed = "copy";
			});

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
	meta.appendChild(moveIndicator);

	card.appendChild(imgContainer);
	card.appendChild(meta);
	card.appendChild(menu);

	return {
		card: card,
		closeBtn: closeBtn,
		pinBtn: pinBtn,
		pinnedBadge: pinnedBadge,
		meta: meta,
		dlBtn: dlBtn,
		retryBtn: retryBtn,
		menu: menu,
		useRefItem: useRefItem,
		compareItem: compareItem,
		editImageItem: editImageItem,
		loadSettingsItem: loadSettingsItem,
		copyPromptItem: copyPromptItem,
		$img: img,
		$spinner: spinner,
		$error: errorDiv,
		$cost: costBadge,
		$timer: timerBadge,
	};
}

function setupJobUI(ui, job) {
	ui.closeBtn.addEventListener("click", () => {
		if (job.pinned && !confirm("Remove this pinned generation?")) {
			return;
		}

		executions.get(job.id)?.abort();
		executions.delete(job.id);

		if (cropJob === job) {
			closeCropModal();
		}

		gallery.invalidate(job.id);

		jobs = jobs.filter(jb => jb.id !== job.id);

		saveJobs();
	});

	ui.retryBtn.addEventListener("click", () => {
		if (job.pinned && !confirm("Retry this pinned generation?")) {
			return;
		}

		startGenerationJob(job);
	});

	ui.pinBtn.addEventListener("click", () => {
		job.pinned = !job.pinned;

		ui.card.classList.toggle("pinned", job.pinned);
		ui.pinBtn.classList.toggle("active", job.pinned);
		ui.pinBtn.title = job.pinned ? "Unpin generation" : "Pin generation";
		ui.pinBtn.querySelector("span").textContent = job.pinned ? "Unpin generation" : "Pin generation";
		ui.pinBtn.setAttribute("aria-pressed", String(job.pinned));
		ui.pinnedBadge.classList.toggle("hidden", !job.pinned);

		saveJobs();

		ui.menu.classList.remove("open");
		ui.card.classList.remove("menu-open");
	});

	ui.meta.addEventListener("dragstart", event => {
		if (event.target.closest(".job-refs")) {
			return;
		}

		closeJobMenus();

		draggedJobCard = ui.card;

		event.dataTransfer.setData("application/paws-job-reorder", job.id);
		event.dataTransfer.effectAllowed = "move";

		ui.card.style.animation = "none";
		ui.card.classList.add("reordering");
	});

	ui.meta.addEventListener("click", event => {
		if (!event.target.closest(".job-refs")) {
			ui.$img.click();
		}
	});

	ui.dlBtn.addEventListener("click", async () => {
		if (!job.result) {
			return;
		}

		const lease = acquireImage(job.result);

		try {
			const link = document.createElement("a"),
				info = await assetInfo(job.result);

			link.href = await lease.url;
			link.download = `p${(job.finishedAt || job.startedAt).toString(16)}.${info.type.split("/")[1] || "png"}`;

			link.click();
		} finally {
			setTimeout(() => lease.release(), 1000);
		}
	});

	ui.$img.addEventListener("click", () => {
		if (job.status !== "pending" && job.result) {
			openImageModal(job.result);
		}
	});

	ui.card.addEventListener("contextmenu", event => {
		event.preventDefault();

		closeJobMenus();

		const panel = $grid.parentElement,
			panelRect = panel.getBoundingClientRect(),
			cardRect = ui.card.getBoundingClientRect();

		ui.menu.style.setProperty("--menu-max-width", `${Math.max(0, panel.clientWidth - 16)}px`);
		ui.menu.style.maxHeight = `${Math.max(0, panel.clientHeight - 16)}px`;
		ui.menu.classList.add("open");
		ui.card.classList.add("menu-open");

		const left = Math.max(panelRect.left + 8, Math.min(event.clientX, panelRect.left + panel.clientWidth - ui.menu.offsetWidth - 8)),
			top = Math.max(panelRect.top + 8, Math.min(event.clientY, panelRect.top + panel.clientHeight - ui.menu.offsetHeight - 8));

		ui.menu.style.left = `${left - cardRect.left}px`;
		ui.menu.style.top = `${top - cardRect.top}px`;
	});

	ui.useRefItem.addEventListener("click", () => {
		useAsReference(job);

		ui.menu.classList.remove("open");
		ui.card.classList.remove("menu-open");
	});

	ui.compareItem.addEventListener("click", () => {
		openComparisonModal(job);

		ui.menu.classList.remove("open");
		ui.card.classList.remove("menu-open");
	});

	ui.editImageItem.addEventListener("click", () => {
		closeJobMenus();
		openCropModal(job, true);
	});

	ui.loadSettingsItem.addEventListener("click", () => {
		loadSettings(job);

		ui.menu.classList.remove("open");
		ui.card.classList.remove("menu-open");
	});

	ui.copyPromptItem.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(`${job.payload.system || ""}\n\n${job.payload.prompt || ""}`);

			ui.menu.classList.remove("open");
			ui.card.classList.remove("menu-open");
		} catch (error) {
			console.error("Failed to copy prompt", error);

			alert("Could not copy the prompt to the clipboard.");
		}
	});

	ui.$img.addEventListener("dragstart", event => {
		if (job.status === "pending" || !job.result) {
			event.preventDefault();

			return;
		}

		startAssetDrag(event, job.result);

		event.dataTransfer.setData("application/paws-result-image", job.id);
		event.dataTransfer.effectAllowed = "copy";
	});
}

async function startGenerationJob(retryJob = null) {
	let job;

	if (retryJob) {
		executions.get(retryJob.id)?.abort();

		if (cropJob === retryJob) {
			closeCropModal();
		}

		gallery.invalidate(retryJob.id);

		job = retryJob;

		job.status = "pending";
		job.result = null;

		delete job.originalResult;
		delete job.crop;
		delete job.brightness;
		delete job.contrast;

		job.error = null;
		job.cost = null;
		job.startedAt = Date.now();
		job.duration = null;
		job.finishedAt = null;
	} else {
		const payload = {
			model: $model.value,
			system: $systemMessage.value.trim(),
			prompt: $prompt.value.trim(),
			images: referenceImages.map(img => img.processed || img.original),
			image: {
				resolution: $resolution.value,
				aspect: $aspectRatio.value,
				quality: $quality.value,
			},
		};

		if (!payload.system && !payload.prompt && payload.images.length === 0) {
			return;
		}

		job = {
			id: crypto.randomUUID(),
			referenceResolution: Number($maxRefResolution.value),
			payload: payload,
			status: "pending",
			result: null,
			error: null,
			startedAt: Date.now(),
		};

		jobs.unshift(job);
	}

	saveJobs();

	const controller = new AbortController(),
		signal = controller.signal,
		isCurrent = () => executions.get(job.id) === controller && !signal.aborted,
		releases = job.payload.images.map(retainAsset);

	executions.set(job.id, controller);

	try {
		await stream("/-/image", await prepareGenerationRequest(job, signal, releases), async chunk => {
			if (!isCurrent()) {
				return;
			}

			if (chunk.type === "image") {
				if (!(chunk.data?.bytes instanceof Uint8Array) || !/^image\/(png|jpeg|webp|gif|avif)$/.test(chunk.data.mime)) {
					throw new Error("Invalid binary image frame");
				}

				const id = await importAsset(new Blob([chunk.data.bytes], { type: chunk.data.mime }), signal);

				if (!isCurrent()) {
					return;
				}

				job.result = id;
			} else if (chunk.type === "error") {
				throw new Error(chunk.data);
			} else if (chunk.type === "usage") {
				job.cost = chunk.data;
			}

			saveJobs();

			gallery.invalidate(job.id);
		});

		if (isCurrent()) {
			if (!job.result) {
				throw new Error("No image returned");
			}

			job.status = "done";
			job.finishedAt = Date.now();

			fetchUsage();
		}
	} catch (error) {
		if (isCurrent()) {
			job.status = "errored";
			job.error = error.message;
		}
	} finally {
		for (const release of releases) {
			release();
		}

		if (isCurrent()) {
			job.duration = Date.now() - job.startedAt;
			executions.delete(job.id);

			saveJobs();

			gallery.invalidate(job.id);
		}
	}
}

async function prepareGenerationRequest(job, signal, releases) {
	// Base64 exists only while preparing/submitting the request, never throughout generation.
	const images = [];

	for (const id of job.payload.images) {
		const prepared = await deriveAsset(id, { max: job.referenceResolution || 0 }, signal);

		releases.push(retainAsset(prepared));
		images.push(await imageDataURL(prepared, signal));
	}

	signal.throwIfAborted();

	return {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			...job.payload,
			images: images
		}),
		signal: signal,
	};
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

		if (data.version != null) {
			$appVersion.textContent = data.version;
			$appVersion.title = `Paws ${$appVersion.textContent}`;
		}

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

				if (model.pricing) {
					const { k_1, k_2, k_4 } = model.pricing;

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

		const modelDropdown = dropdown($model, favorites);

		modelDropdown.switchTab(load("modelTab", "all") === "favorites" ? "favorites" : "all");

		$model.addEventListener("favorite", event => {
			store("favorites", event.detail);
		});

		updateAvailableOptions();
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

function isRefReorderDrag(dataTransfer) {
	return Array.from(dataTransfer?.types || []).includes("application/paws-ref-sort");
}

function isOverReferenceImages(target) {
	return target instanceof Element && Boolean(target.closest("#reference-images"));
}

function isImageDrop(dataTransfer) {
	if (!dataTransfer) {
		return false;
	}

	const types = Array.from(dataTransfer.types);

	return types.includes("Files") || types.includes("application/paws-asset") || types.includes("application/paws-result-image") || types.includes("application/paws-reference-image");
}

function startAssetDrag(event, id) {
	releaseDrag?.();

	draggedImageSource = id;
	releaseDrag = retainAsset(id);

	event.dataTransfer.setData("application/paws-asset", id);
}

function setPageDragOver(active) {
	document.body.classList.toggle("drag-over", active);

	$refImagesContainer.classList.toggle("drag-over", active);
}

function clearPageDragOver() {
	pageDragDepth = 0;
	setPageDragOver(false);
}

document.addEventListener("dragenter", event => {
	if (isRefReorderDrag(event.dataTransfer) && isOverReferenceImages(event.target)) {
		return;
	}

	if (!isImageDrop(event.dataTransfer)) {
		return;
	}

	pageDragDepth++;

	setPageDragOver(true);
});

document.addEventListener("dragover", event => {
	if (isRefReorderDrag(event.dataTransfer) && isOverReferenceImages(event.target)) {
		return;
	}

	if (!isImageDrop(event.dataTransfer)) {
		return;
	}

	event.preventDefault();
	event.dataTransfer.dropEffect = "copy";
});

document.addEventListener("dragleave", event => {
	if (!isImageDrop(event.dataTransfer)) {
		return;
	}

	if (!event.relatedTarget) {
		clearPageDragOver();

		return;
	}

	pageDragDepth = Math.max(0, pageDragDepth - 1);

	if (pageDragDepth === 0) {
		setPageDragOver(false);
	}
});

document.addEventListener("drop", async event => {
	clearPageDragOver();

	if (isRefReorderDrag(event.dataTransfer) && isOverReferenceImages(event.target)) {
		return;
	}

	const internal = event.dataTransfer?.getData("application/paws-asset");

	if (internal || draggedImageSource) {
		event.preventDefault();

		const id = internal || draggedImageSource;

		if (!isAssetId(id)) {
			return;
		}

		const release = retainAsset(id);

		try {
			await addReferenceImage(id);
		} finally {
			release();
		}

		return;
	}

	const data = event.dataTransfer?.getData("text/plain"),
		files = event.dataTransfer?.files,
		hasImageFiles = files && [...files].some(file => file.type.startsWith("image/")),
		source = data?.startsWith("data:image") ? data : null;

	if (!hasImageFiles && !source) {
		return;
	}

	event.preventDefault();

	if (source) {
		await addReferenceImage(source);

		return;
	}

	await handleFiles(files);
});

document.addEventListener("dragend", () => {
	releaseDrag?.();
	releaseDrag = null;

	draggedImageSource = null;

	clearPageDragOver();
});

window.addEventListener("blur", clearPageDragOver);

window.addEventListener("beforeunload", event => {
	if (!jobs.some(job => job.status === "pending")) {
		return;
	}

	event.preventDefault();
	event.returnValue = "";
});

document.addEventListener("paste", async event => {
	const items = event.clipboardData?.items;

	if (!items) {
		return;
	}

	const imageFiles = [];

	for (const item of items) {
		if (item.type.startsWith("image/")) {
			const file = item.getAsFile();

			if (file) {
				imageFiles.push(file);
			}
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

	updateResolutionEstimate();

	if (!isApplyingPreset) {
		syncPresetSelection();
	}
});

$systemMessage.addEventListener("input", () => {
	updateResolutionEstimate();

	if (!useDefaultSys) {
		store("customSystem", $systemMessage.value);
		store("system", $systemMessage.value);
	}

	if (!isApplyingPreset) {
		syncPresetSelection();
	}
});

$prompt.addEventListener("input", () => {
	updateResolutionEstimate();

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

	updateAvailableOptions();
});

$model.addEventListener("tab", event => {
	if (event.detail === "all" || event.detail === "favorites") {
		store("modelTab", event.detail);
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

$quality.addEventListener("change", () => {
	store("quality", $quality.value);

	updateResolutionEstimate();
});

$maxRefResolution.addEventListener("change", () => {
	store("maxRefResolution", $maxRefResolution.value);

	updateResolutionEstimate();
});

$generateBtn.addEventListener("click", () => startGenerationJob());

$fullImage.addEventListener("pointerdown", event => {
	if (event.button !== 0 || event.pointerType === "touch" || imageZoomPointerId !== null || !$fullImage.naturalWidth) {
		return;
	}

	event.preventDefault();

	imageZoomPointerId = event.pointerId;

	$fullImage.setPointerCapture(event.pointerId);

	$imageZoom.classList.remove("hidden");

	updateImageZoom(event);
});

$fullImage.addEventListener("pointermove", event => {
	if (event.pointerId !== imageZoomPointerId) {
		return;
	}

	if (!(event.buttons & 1)) {
		stopImageZoom();

		return;
	}

	updateImageZoom(event);
});

for (const eventName of ["pointerup", "pointercancel", "lostpointercapture"]) {
	$fullImage.addEventListener(eventName, event => {
		if (event.pointerId === imageZoomPointerId) {
			stopImageZoom();
		}
	});
}

$fullImage.addEventListener("dragstart", event => event.preventDefault());

window.addEventListener("blur", stopImageZoom);

$imageModal.querySelector(".background").addEventListener("click", closeImageModal);

$closeImageModal.addEventListener("click", closeImageModal);

$cropModal.querySelector(".background").addEventListener("click", closeCropModal);

$closeCropModal.addEventListener("click", closeCropModal);

$resizeModal.querySelector(".background").addEventListener("click", closeResizeModal);
$cancelResizeBtn.addEventListener("click", closeResizeModal);
$resizeWidth.addEventListener("input", () => updateResizeDimensions($resizeWidth));
$resizeHeight.addEventListener("input", () => updateResizeDimensions($resizeHeight));
$resizePercent.addEventListener("input", applyResizePercentage);

$resizeModal.addEventListener("keydown", event => {
	if (event.key !== "Tab") {
		return;
	}

	const controls = $resizeForm.querySelectorAll("input:not(:disabled), button:not(:disabled)"),
		first = controls[0],
		last = controls[controls.length - 1];

	if (event.shiftKey && document.activeElement === first) {
		event.preventDefault();

		last.focus();
	} else if (!event.shiftKey && document.activeElement === last) {
		event.preventDefault();

		first.focus();
	}
});

$resizeForm.addEventListener("submit", async event => {
	event.preventDefault();

	const state = resizeState;

	if (!state || $applyResizeBtn.disabled || !$resizeForm.reportValidity()) {
		return;
	}

	const item = state.item,
		max = state.max < Math.max(state.width, state.height) ? state.max : 0;

	$applyResizeBtn.disabled = true;
	$resizeWidth.disabled = true;
	$resizeHeight.disabled = true;
	$resizePercent.disabled = true;

	$resizeModal.classList.add("loading");
	$resizeModal.classList.remove("errored");

	try {
		const result = await deriveAsset(item.original, {
			crop: item.crop,
			brightness: item.brightness || 0,
			contrast: item.contrast || 0,
			max: max,
			format: max || item.crop || item.brightness || item.contrast ? "image/png" : undefined
		}, state.controller.signal);

		if (resizeState !== state || !referenceImages.includes(item)) {
			return;
		}

		item.resizeMax = max;
		item.processed = result;

		closeResizeModal();
		renderReferenceImages();

		$refImagesContainer.querySelectorAll(".resize-ref-btn")[referenceImages.indexOf(item)]?.focus();
	} catch (error) {
		if (resizeState === state && error.name !== "AbortError") {
			$resizeError.textContent = "Could not resize the image. Please try again.";
			$resizeModal.classList.add("errored");
		}
	} finally {
		if (resizeState === state) {
			$resizeModal.classList.remove("loading");
			$applyResizeBtn.disabled = false;
			$resizeWidth.disabled = false;
			$resizeHeight.disabled = false;
			$resizePercent.disabled = false;
		}
	}
});

$resetCropBtn.addEventListener("click", () => {
	if (!cropItem && !cropJob) {
		return;
	}

	crop = { x: 0, y: 0, width: 1, height: 1 };

	$cropBrightness.value = 0;
	$cropContrast.value = 0;

	updateCropAdjustments();
	renderCropPreview();
	renderCropSelection();
});

$applyCropBtn.addEventListener("click", async () => {
	if ((!cropItem && !cropJob) || !crop) {
		return;
	}

	$cropModal.classList.add("loading");

	const selection = crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1 ? undefined : { ...crop },
		brightness = Number($cropBrightness.value),
		contrast = Number($cropContrast.value),
		session = cropSession,
		job = cropJob,
		item = cropItem,
		signal = cropController.signal,
		original = job ? job.originalResult || job.result : item.original,
		hasEdits = Boolean(selection || brightness || contrast || item?.resizeMax),
		edits = {
			crop: selection,
			brightness: brightness,
			contrast: contrast,
			max: item?.resizeMax || 0,
			format: "image/png",
		};

	$applyCropBtn.disabled = true;

	try {
		const result = hasEdits ? await deriveAsset(original, edits, signal) : original;

		if (job) {
			if (session !== cropSession || !jobs.includes(job)) {
				return;
			}

			job.result = result;
			job.crop = selection;
			job.brightness = brightness;
			job.contrast = contrast;

			if (result === original) {
				delete job.originalResult;
			} else {
				job.originalResult = original;
			}

			gallery.invalidate(job.id);
			saveJobs();
		} else {
			if (session !== cropSession || !referenceImages.includes(item)) {
				return;
			}

			item.crop = selection;
			item.brightness = brightness;
			item.contrast = contrast;
			item.processed = result;

			renderReferenceImages();
		}

		closeCropModal();
	} catch (error) {
		if (error.name !== "AbortError") {
			console.error("Failed to edit image", error);

			alert("Could not apply the image edits.");
		}
	} finally {
		if (session === cropSession) {
			$applyCropBtn.disabled = false;
			$cropModal.classList.remove("loading");
		}
	}
});

[$cropBrightness, $cropContrast].forEach(input => input.addEventListener("input", () => {
	updateCropAdjustments();

	cancelAnimationFrame(cropPreviewFrame);

	cropPreviewFrame = requestAnimationFrame(renderCropPreview);
}));

$cropStage.addEventListener("pointerdown", event => {
	if (!crop || event.target.closest(".crop-selection")) {
		return;
	}

	const bounds = $cropStage.getBoundingClientRect(),
		startX = clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
		startY = clamp((event.clientY - bounds.top) / bounds.height, 0, 1);

	crop = { x: startX, y: startY, width: 0, height: 0 };
	cropDrag = { type: "create", startX, startY };

	$cropStage.setPointerCapture(event.pointerId);

	renderCropSelection();
});

$cropSelection.addEventListener("pointerdown", event => {
	if (!crop) {
		return;
	}

	const handle = event.target.dataset.handle;

	cropDrag = {
		type: handle ? "resize" : "move",
		handle: handle,
		startCrop: { ...crop },
		startX: event.clientX,
		startY: event.clientY
	};

	$cropStage.setPointerCapture(event.pointerId);

	event.stopPropagation();
});

$cropStage.addEventListener("pointermove", event => {
	if (!cropDrag || !crop) {
		return;
	}

	const bounds = $cropStage.getBoundingClientRect(),
		x = clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
		y = clamp((event.clientY - bounds.top) / bounds.height, 0, 1),
		minSize = 0.04;

	if (cropDrag.type === "create") {
		const left = Math.min(cropDrag.startX, x),
			top = Math.min(cropDrag.startY, y),
			right = Math.max(cropDrag.startX, x),
			bottom = Math.max(cropDrag.startY, y);

		crop = {
			x: left,
			y: top,
			width: Math.min(1 - left, Math.max(minSize, right - left)),
			height: Math.min(1 - top, Math.max(minSize, bottom - top)),
		};
	} else if (cropDrag.type === "move") {
		const start = cropDrag.startCrop,
			dx = (event.clientX - cropDrag.startX) / bounds.width,
			dy = (event.clientY - cropDrag.startY) / bounds.height;

		crop.x = clamp(start.x + dx, 0, 1 - start.width);
		crop.y = clamp(start.y + dy, 0, 1 - start.height);
	} else {
		const start = cropDrag.startCrop,
			handle = cropDrag.handle,
			left = handle.includes("w") ? Math.min(x, start.x + start.width - minSize) : start.x,
			top = handle.includes("n") ? Math.min(y, start.y + start.height - minSize) : start.y,
			right = handle.includes("e") ? Math.max(x, start.x + minSize) : start.x + start.width,
			bottom = handle.includes("s") ? Math.max(y, start.y + minSize) : start.y + start.height;

		crop = { x: left, y: top, width: right - left, height: bottom - top };
	}

	renderCropSelection();
});

$cropStage.addEventListener("pointerup", () => {
	cropDrag = null;
});

$cropStage.addEventListener("pointercancel", () => {
	cropDrag = null;
});

$comparisonRange.addEventListener("input", updateComparisonPosition);

$comparisonReferenceSelect.addEventListener("change", () => {
	bindImage($comparisonBefore, $comparisonReferenceSelect.value);
});

function closeComparisonModal() {
	$comparisonModal.classList.remove("open");

	releaseImage($comparisonBefore);
	releaseImage($comparisonAfter);
}

$comparisonModal.querySelector(".background").addEventListener("click", closeComparisonModal);
$closeComparisonModal.addEventListener("click", closeComparisonModal);

resDropdown = dropdown($resolution);
aspectDropdown = dropdown($aspectRatio);
qualityDropdown = dropdown($quality);
dropdown($maxRefResolution);

if (referenceImages.length > 0) {
	renderReferenceImages();
}

await loadData();

for (const job of jobs) {
	if (job.status === "pending") {
		job.status = "errored";
		job.error = "Aborted (page reload)";
	}

}

gallery = new Gallery($grid, () => jobs, job => {
	const ui = createJobDOM(job);

	setupJobUI(ui, job);

	return ui;
});

saveJobs();

function normalizePresetOrder() {
	const names = presets.map(preset => preset.name);

	presetOrder = presetOrder.filter(name => names.includes(name));

	for (const name of names) {
		if (!presetOrder.includes(name)) {
			presetOrder.push(name);
		}
	}
}

function sortPresetsByOrder(list = []) {
	normalizePresetOrder();

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
		unsavedOption.dataset.noFavorite = "";

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

	dropdown($presetSelect, { reorderable: true });
}

function applyPreset(preset) {
	if (!preset) {
		return;
	}

	isApplyingPreset = true;

	try {
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
		preset.prompt === current.prompt &&
		preset.system === current.system &&
		preset.useDefaultSystem === current.useDefaultSystem
	);
}

function syncPresetSelection(refresh = false) {
	if (!$presetSelect) {
		return;
	}

	const match = findMatchingPreset(),
		selectedName = match?.name || "";

	activePresetName = selectedName;

	if (refresh) {
		renderPresets(selectedName);

		return;
	}

	if (match) {
		$presetSelect.value = match.name;

		if ($deletePresetBtn) {
			$deletePresetBtn.disabled = false;
		}

		return;
	}

	$presetSelect.value = "";

	if ($deletePresetBtn) {
		$deletePresetBtn.disabled = true;
	}
}

$presetSelect.addEventListener("reorder", event => {
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
		closeJobMenus();

		if ($savePresetModal?.classList.contains("open")) {
			$savePresetModal.classList.remove("open");
		}

		if ($imageModal?.classList.contains("open")) {
			closeImageModal();
		}

		if ($comparisonModal?.classList.contains("open")) {
			closeComparisonModal();
		}

		if ($cropModal?.classList.contains("open")) {
			closeCropModal();
		}

		if ($resizeModal.classList.contains("open")) {
			closeResizeModal();
		}
	}
});

renderPresets();

syncPresetSelection();

setComposerPane(activeComposerPane, false);

fetchUsage();

$loader.classList.add("hidden");
