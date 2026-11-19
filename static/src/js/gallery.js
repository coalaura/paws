import { releaseImages } from "./image-assets.js";

export class Gallery {
	constructor(grid, getJobs, createCard) {
		this.grid = grid;
		this.panel = grid.parentElement;
		this.getJobs = getJobs;
		this.createCard = createCard;
		this.mounted = new Map();
		this.frame = 0;

		this.panel.addEventListener("scroll", () => this.schedule(), { passive: true });

		this.observer = new ResizeObserver(() => {
			for (const entry of this.mounted.values()) {
				entry.ui.menu.classList.remove("open");
				entry.ui.card.classList.remove("menu-open");
			}

			this.schedule();
		});
		this.observer.observe(this.panel);

		this.timer = setInterval(() => {
			for (const entry of this.mounted.values()) {
				if (entry.job.status === "pending") {
					entry.ui.$timer.textContent = `${Math.floor((Date.now() - entry.job.startedAt) / 1000)}s`;
				}
			}
		}, 1000);
	}

	schedule() {
		if (!this.frame) {
			this.frame = requestAnimationFrame(() => {
				this.frame = 0;

				this.render();
			});
		}
	}

	invalidate(id) {
		const entry = this.mounted.get(id);

		if (entry) {
			releaseImages(entry.ui.card);

			entry.ui.card.remove();

			this.mounted.delete(id);
		}

		this.schedule();
	}

	render() {
		const jobs = this.getJobs(),
			columns = Number(getComputedStyle(this.grid).getPropertyValue("--cols")) || 1,
			cell = this.panel.clientWidth / columns;

		if (!cell) {
			return;
		}

		const rows = Math.ceil(jobs.length / columns),
			height = rows * cell;

		this.grid.style.height = `${height}px`;

		if (this.anchor && this.scroll === this.panel.scrollTop && this.scroll > 0) {
			const anchorIndex = jobs.findIndex(job => job.id === this.anchor.id);

			if (anchorIndex !== -1) {
				this.panel.scrollTop = Math.floor(anchorIndex / columns) * cell + this.anchor.offset * cell;
			}
		}

		const scroll = Math.min(this.panel.scrollTop, Math.max(0, height - this.panel.clientHeight)),
			anchor = jobs[Math.floor(scroll / cell) * columns];

		this.scroll = scroll;
		this.anchor = anchor ? { id: anchor.id, offset: scroll % cell / cell } : null;

		const first = Math.max(0, Math.floor(scroll / cell) - 2) * columns,
			last = Math.min(jobs.length, (Math.ceil((scroll + this.panel.clientHeight) / cell) + 2) * columns),
			visible = new Set(jobs.slice(first, last).map(job => job.id));

		for (const [id, entry] of this.mounted) {
			if (!visible.has(id) && !entry.ui.card.classList.contains("reordering")) {
				releaseImages(entry.ui.card);

				entry.ui.card.remove();

				this.mounted.delete(id);
			}
		}

		for (let index = first; index < last; index++) {
			const job = jobs[index];

			let entry = this.mounted.get(job.id);

			if (!entry) {
				entry = {
					job: job,
					ui: this.createCard(job)
				};

				this.mounted.set(job.id, entry);
				this.grid.append(entry.ui.card);
			}

			const card = entry.ui.card;

			card.style.width = `${cell - 1}px`;
			card.style.height = `${cell - 1}px`;
			card.style.left = `${index % columns * cell}px`;
			card.style.top = `${Math.floor(index / columns) * cell}px`;
		}
	}
}
