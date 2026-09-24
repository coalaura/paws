import "../css/paws.css";
import "../css/dropdown.css";

import { unpack } from "msgpackr";

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

await connectDB();

let rawRefs = load("referenceImages", []),
	referenceImages = rawRefs.map(item => (typeof item === "string" ? { original: item, processed: item } : item)),
	jobs = load("jobs", []),
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
	cropItem = null,
	cropJob = null,
	cropJobImage = null,
	cropSourceImage = null,
	cropPreviewFrame = 0,
	crop = null,
	cropDrag = null,
	draggedImageSource = null,
	draggedJobCard = null;

const jobImageUrls = new Map();

let costEstimateSeq = 0;

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

	store("jobs", jobs);
}

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

	if (before && target.previousElementSibling !== draggedJobCard) {
		target.before(draggedJobCard);
	} else if (!before && target.nextElementSibling !== draggedJobCard) {
		target.after(draggedJobCard);
	}
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

	const jobsById = new Map(jobs.map(job => [job.id, job]));

	jobs = Array.from($grid.querySelectorAll(".job-card"), card => jobsById.get(card.dataset.jobId));

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

function setJobImageSource(img, job) {
	const result = job.result;

	if (!result) {
		return;
	}

	const existing = jobImageUrls.get(job.id);

	if (existing?.source === result) {
		img.src = existing.url;

		return;
	}

	if (existing) {
		URL.revokeObjectURL(existing.url);
		jobImageUrls.delete(job.id);
	}

	fetch(result)
		.then(response => response.blob())
		.then(blob => {
			if (job.result !== result) {
				return;
			}

			const objectUrl = URL.createObjectURL(blob);

			jobImageUrls.set(job.id, {
				source: result,
				url: objectUrl
			});

			img.src = objectUrl;
		})
		.catch(() => {
			img.src = result;
		});
}

function releaseJobImageUrl(job) {
	const image = jobImageUrls.get(job.id);

	if (image) {
		URL.revokeObjectURL(image.url);
		jobImageUrls.delete(job.id);
	}
}

function addReferenceImage(source) {
	if (!source || referenceImages.length >= MaxImages) {
		return;
	}

	return processRefImage(source).then(processed => {
		referenceImages.push({
			original: source,
			processed: processed
		});

		renderReferenceImages();
	});
}

function openImageModal(src) {
	$fullImage.src = src;

	$imageModal.classList.add("open");
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

// Use the same tone curve for the preview and the saved pixels.
function adjustImageTones(ctx, width, height, brightness, contrast) {
	if (!brightness && !contrast) {
		return;
	}

	const imageData = ctx.getImageData(0, 0, width, height),
		pixels = imageData.data,
		curve = new Uint8Array(256),
		strength = 8 * Math.max(0, contrast) / 100,
		endpoint = Math.tanh(strength / 2),
		gamma = Math.pow(2, -brightness / 100);

	for (let value = 0; value < 256; value++) {
		const input = value / 255;

		let tone = input;

		if (contrast > 0) {
			tone = (Math.tanh((input - 0.5) * strength) / endpoint + 1) / 2;
		} else if (contrast < 0) {
			// Lift blacks and lower whites instead of steepening the midtones.
			tone = 0.5 + (input - 0.5) * (1 + contrast / 100);
		}

		curve[value] = Math.round(255 * Math.pow(clamp(tone, 0, 1), gamma));
	}

	for (let index = 0; index < pixels.length; index += 4) {
		pixels[index] = curve[pixels[index]];
		pixels[index + 1] = curve[pixels[index + 1]];
		pixels[index + 2] = curve[pixels[index + 2]];
	}

	ctx.putImageData(imageData, 0, 0);
}

function renderCropPreview() {
	if (!cropSourceImage?.complete || !cropSourceImage.naturalWidth) {
		return;
	}

	const brightness = Number($cropBrightness.value),
		contrast = Number($cropContrast.value);

	if (!brightness && !contrast) {
		$cropImage.src = cropSourceImage.src;

		return;
	}

	const scale = Math.min(1, 1000 / Math.max(cropSourceImage.naturalWidth, cropSourceImage.naturalHeight)),
		canvas = document.createElement("canvas");

	canvas.width = Math.max(1, Math.round(cropSourceImage.naturalWidth * scale));
	canvas.height = Math.max(1, Math.round(cropSourceImage.naturalHeight * scale));

	const ctx = canvas.getContext("2d");

	ctx.drawImage(cropSourceImage, 0, 0, canvas.width, canvas.height);

	adjustImageTones(ctx, canvas.width, canvas.height, brightness, contrast);

	$cropImage.src = canvas.toDataURL("image/png");
}

function openCropModal(item, jobImage = null) {
	cropItem = jobImage ? null : item;
	cropJob = jobImage ? item : null;
	cropJobImage = jobImage;

	crop = item.crop ? { ...item.crop } : { x: 0, y: 0, width: 1, height: 1 };

	$cropBrightness.value = item.brightness || 0;
	$cropContrast.value = item.contrast || 0;
	$cropTitle.textContent = jobImage ? "Edit Generation" : "Edit Reference";

	updateCropAdjustments();

	const source = new Image();

	cropSourceImage = source;

	source.onload = () => {
		if (cropSourceImage === source) {
			renderCropPreview();
			renderCropSelection();
		}
	};

	source.src = jobImage ? item.originalResult || item.result : item.original;

	$cropImage.src = source.src;
	$cropModal.classList.add("open");

	requestAnimationFrame(renderCropSelection);
}

function closeCropModal() {
	$cropModal.classList.remove("open");

	cropItem = null;
	cropJob = null;
	cropJobImage = null;
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
	$comparisonAfter.src = job.result;
	$comparisonBefore.src = refs[0];
	$comparisonRange.value = 50;

	updateComparisonPosition();

	$comparisonModal.classList.add("open");
}

function readFileAsDataUrl(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();

		reader.onload = () => resolve(reader.result);
		reader.onerror = reject;

		reader.readAsDataURL(file);
	});
}

function processImage(dataUrl, cropRect, brightness, contrast, maxRes, format) {
	return new Promise((resolve, reject) => {
		const img = new Image();

		img.onload = () => {
			try {
				const sourceX = Math.round((cropRect?.x || 0) * img.naturalWidth),
					sourceY = Math.round((cropRect?.y || 0) * img.naturalHeight),
					sourceWidth = Math.max(1, Math.round((cropRect?.width || 1) * img.naturalWidth)),
					sourceHeight = Math.max(1, Math.round((cropRect?.height || 1) * img.naturalHeight));

					let width = sourceWidth,
					height = sourceHeight;

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

				ctx.drawImage(img, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);

				adjustImageTones(ctx, width, height, brightness, contrast);

				resolve(canvas.toDataURL(format, 0.92));
			} catch (error) {
				reject(error);
			}
		};

		img.onerror = reject;
		img.src = dataUrl;
	});
}

function processRefImage(dataUrl, cropRect, brightness = 0, contrast = 0) {
	const maxRes = parseInt($maxRefResolution.value, 10) || 0;

	return processImage(dataUrl, cropRect, brightness, contrast, maxRes, "image/jpeg");
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

	resDropdown.setAvailable(resolutions);
	aspectDropdown.setAvailable(aspectRatios);
	qualityDropdown.setAvailable(qualities);

	store("resolution", $resolution.value);
	store("aspect", $aspectRatio.value);
	store("quality", $quality.value);

	updateResolutionEstimate();
}

function updateResolutionEstimate() {
	const $costSpan = document.getElementById("resolution-estimate-cost");

	if (!$costSpan) {
		return;
	}

	fetchCostEstimate($costSpan);
}

async function fetchCostEstimate($costSpan) {
	const model = $model.value;

	if (!model) {
		hideCostEstimate($costSpan);

		return;
	}

	const seq = ++costEstimateSeq;

	const references = [];

	for (const item of referenceImages) {
		const size = await imageSize(item.processed || item.original);

		if (seq !== costEstimateSeq) {
			return;
		}

		if (size.width > 0 && size.height > 0) {
			references.push(size);
		}
	}

	let response;

	try {
		response = await fetch("/-/cost", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: model,
				quality: $quality.value,
				aspect: $aspectRatio.value,
				resolution: $resolution.value,
				references: references,
			}),
		});
	} catch (err) {
		console.error("Failed to fetch cost estimate", err);

		if (seq === costEstimateSeq) {
			hideCostEstimate($costSpan);
		}

		return;
	}

	if (seq !== costEstimateSeq) {
		return;
	}

	if (!response.ok) {
		hideCostEstimate($costSpan);

		return;
	}

	const data = await response.json().catch(() => null);

	if (seq !== costEstimateSeq) {
		return;
	}

	if (data?.estimate != null && data.estimate > 0) {
		$costSpan.textContent = `~${formatMoney(data.estimate)}`;

		const $container = document.getElementById("resolution-estimate");

		if ($container) {
			$container.classList.remove("hidden");
		}

		return;
	}

	hideCostEstimate($costSpan);
}

function hideCostEstimate($costSpan) {
	const $container = document.getElementById("resolution-estimate");

	if ($container) {
		$container.classList.add("hidden");
	}

	$costSpan.textContent = "";
}

function imageSize(src) {
	return new Promise(resolve => {
		if (!src) {
			resolve({ width: 0, height: 0 });

			return;
		}

		const img = new Image();

		img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
		img.onerror = () => resolve({ width: 0, height: 0 });

		img.src = src;
	});
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

		const editBtn = document.createElement("button");

		editBtn.className = "edit-ref-btn";
		editBtn.textContent = "Edit";
		editBtn.title = "Crop and adjust image";
		editBtn.addEventListener("pointerdown", event => event.stopPropagation());
		editBtn.addEventListener("click", () => openCropModal(item));

		wrapper.appendChild(editBtn);

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
			draggedImageSource = item.original;
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

		const dataUrl = await readFileAsDataUrl(file),
			processed = await processRefImage(dataUrl);

		referenceImages.push({ original: dataUrl, processed: processed });
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
		setJobImageSource(img, job);

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

	img.addEventListener("load", () => {
		if (img.naturalWidth && img.naturalHeight) {
			aspectBadge.textContent = calculateAspectRatio(img.naturalWidth, img.naturalHeight);

			aspectBadge.classList.remove("hidden");
		}
	});

	imgContainer.appendChild(specs);

	const meta = document.createElement("div");

	meta.className = "job-meta";
	meta.draggable = true;

	if (refs.length > 0) {
		const refsDiv = document.createElement("div");

		refsDiv.className = "job-refs";

		for (const src of refs) {
			const refImg = document.createElement("img");

			refImg.src = src;
			refImg.draggable = true;

			refImg.addEventListener("dragstart", event => {
				draggedImageSource = src;
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

function setupJobUI(ui, job, controller = null, clearTimer = null) {
	let isDone = job.status !== "pending";

	const cleanupActions = () => {
		isDone = true;

		ui.$spinner.classList.add("hidden");
		ui.retryBtn.classList.remove("hidden");
	};

	ui.closeBtn.addEventListener("click", () => {
		if (job.pinned && !confirm("Remove this pinned generation?")) {
			return;
		}

		if (clearTimer) {
			clearTimer();
		}

		if (!isDone && controller) {
			controller.abort();
		}

		ui.card.remove();
		releaseJobImageUrl(job);

		jobs = jobs.filter(jb => jb.id !== job.id);

		saveJobs();
	});

	ui.retryBtn.addEventListener("click", () => {
		if (job.pinned && !confirm("Retry this pinned generation?")) {
			return;
		}

		if (clearTimer) {
			clearTimer();
		}

		if (!isDone && controller) {
			controller.abort();
		}

		startGenerationJob(job, ui.card);
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

	ui.dlBtn.addEventListener("click", () => {
		if (!ui.$img.src) {
			return;
		}

		const a = document.createElement("a");

		a.href = job.result;
		a.download = `p${(job.finishedAt || job.startedAt).toString(16)}.png`;

		a.click();
	});

	ui.$img.addEventListener("click", () => {
		if (isDone && ui.$img.src && typeof openImageModal === "function") {
			openImageModal(ui.$img.src);
		}
	});

	ui.card.addEventListener("contextmenu", event => {
		event.preventDefault();

		closeJobMenus();

		const panelRect = $grid.parentElement.getBoundingClientRect(),
			cardRect = ui.card.getBoundingClientRect();

		ui.menu.style.maxHeight = `${Math.max(0, panelRect.height - 16)}px`;
		ui.menu.classList.add("open");
		ui.card.classList.add("menu-open");

		const left = Math.max(panelRect.left + 8, Math.min(event.clientX, panelRect.right - ui.menu.offsetWidth - 8)),
			top = Math.max(panelRect.top + 8, Math.min(event.clientY, panelRect.bottom - ui.menu.offsetHeight - 8));

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
		openCropModal(job, ui.$img);
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
		if (!isDone || !job.result) {
			event.preventDefault();

			return;
		}

		draggedImageSource = job.result;

		event.dataTransfer.setData("application/paws-result-image", job.id);
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
		releaseJobImageUrl(retryJob);

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
			images: referenceImages.map(img => img.processed || img),
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
					ui.editImageItem.disabled = false;

					job.status = "done";
					job.finishedAt ||= Date.now();

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
					job.result = chunk.data;

					setJobImageSource(ui.$img, job);

					ui.$img.classList.remove("hidden");

					if (ui.useRefItem) {
						ui.useRefItem.disabled = false;
					}

					if (ui.compareItem && (job.payload.images || []).length > 0) {
						ui.compareItem.disabled = false;
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
					ui.editImageItem.disabled = false;

					job.status = "done";
					job.finishedAt ||= Date.now();

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

	return types.includes("Files") || types.includes("application/paws-result-image") || types.includes("application/paws-reference-image");
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

	const data = event.dataTransfer?.getData("text/plain"),
		files = event.dataTransfer?.files,
		hasImageFiles = files && [...files].some(file => file.type.startsWith("image/")),
		source = draggedImageSource || (data?.startsWith("data:image") ? data : null);

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

$maxRefResolution.addEventListener("change", async () => {
	store("maxRefResolution", $maxRefResolution.value);

	if (referenceImages.length > 0) {
		for (const referenceImage of referenceImages) {
			referenceImage.processed = await processRefImage(
				referenceImage.original, referenceImage.crop, referenceImage.brightness || 0, referenceImage.contrast || 0
			);
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

$cropModal.querySelector(".background").addEventListener("click", closeCropModal);

$closeCropModal.addEventListener("click", closeCropModal);

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
		contrast = Number($cropContrast.value);

	try {
		if (cropJob) {
			const original = cropJob.originalResult || cropJob.result,
				result = selection || brightness || contrast
					? await processImage(original, selection, brightness, contrast, 0, "image/png")
					: original;

			cropJob.result = result;
			cropJob.crop = selection;
			cropJob.brightness = brightness;
			cropJob.contrast = contrast;

			if (result === original) {
				delete cropJob.originalResult;
			} else {
				cropJob.originalResult = original;
			}

			setJobImageSource(cropJobImage, cropJob);
			saveJobs();
		} else {
			const processed = await processRefImage(cropItem.original, selection, brightness, contrast);

			cropItem.crop = selection;
			cropItem.brightness = brightness;
			cropItem.contrast = contrast;
			cropItem.processed = processed;

			renderReferenceImages();
		}

		closeCropModal();
	} catch (error) {
		console.error("Failed to edit image", error);
		alert("Could not apply the image edits.");
	} finally {
		$cropModal.classList.remove("loading");
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
	$comparisonBefore.src = $comparisonReferenceSelect.value;
});

$comparisonModal.querySelector(".background").addEventListener("click", () => {
	$comparisonModal.classList.remove("open");
});

$closeComparisonModal.addEventListener("click", () => {
	$comparisonModal.classList.remove("open");
});

resDropdown = dropdown($resolution);
aspectDropdown = dropdown($aspectRatio);
qualityDropdown = dropdown($quality);
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
			$imageModal.classList.remove("open");
		}

		if ($comparisonModal?.classList.contains("open")) {
			$comparisonModal.classList.remove("open");
		}

		if ($cropModal?.classList.contains("open")) {
			closeCropModal();
		}
	}
});

renderPresets();

syncPresetSelection();

setComposerPane(activeComposerPane, false);

fetchUsage();

$loader.remove();
