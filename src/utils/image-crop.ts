/** One-time image crop before admin upload. Returns null if the user cancels. */

type Rect = { x: number; y: number; w: number; h: number };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function loadImage(file: File): Promise<{ image: HTMLImageElement; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({ image, url });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that image."));
    };
    image.src = url;
  });
}

function outputType(file: File) {
  if (file.type === "image/jpeg" || file.type === "image/jpg") return { mime: "image/jpeg", ext: "jpg", quality: 0.92 };
  return { mime: "image/png", ext: "png", quality: undefined };
}

function renameCropped(file: File, ext: string) {
  const base = file.name.replace(/\.[^.]+$/, "") || "image";
  return `${base}-cropped.${ext}`;
}

export async function cropImageFile(file: File): Promise<File | null> {
  if (!file.type.startsWith("image/")) return file;
  const { image, url } = await loadImage(file);
  return new Promise((resolve) => {
    const existing = document.getElementById("adminCropModal");
    existing?.remove();

    const maxBox = Math.min(720, Math.floor(window.innerWidth - 48), Math.floor(window.innerHeight - 220));
    const scale = Math.min(maxBox / image.naturalWidth, maxBox / image.naturalHeight, 1);
    const displayW = Math.max(1, Math.round(image.naturalWidth * scale));
    const displayH = Math.max(1, Math.round(image.naturalHeight * scale));
    const minSize = 40;

    let crop: Rect = {
      x: Math.round(displayW * 0.05),
      y: Math.round(displayH * 0.05),
      w: Math.round(displayW * 0.9),
      h: Math.round(displayH * 0.9),
    };

    document.body.insertAdjacentHTML("beforeend", `
      <div class="admin-crop-modal" id="adminCropModal" role="dialog" aria-modal="true" aria-labelledby="adminCropTitle">
        <div class="admin-crop-modal__dialog">
          <h3 id="adminCropTitle">Crop image</h3>
          <p class="admin-crop-modal__copy">Drag the box to move it, or drag a corner to resize. This only applies once before upload.</p>
          <div class="admin-crop-stage" style="width:${displayW}px;height:${displayH}px">
            <img src="${url}" alt="" width="${displayW}" height="${displayH}" draggable="false">
            <div class="admin-crop-shade admin-crop-shade--top" data-shade="top"></div>
            <div class="admin-crop-shade admin-crop-shade--left" data-shade="left"></div>
            <div class="admin-crop-shade admin-crop-shade--right" data-shade="right"></div>
            <div class="admin-crop-shade admin-crop-shade--bottom" data-shade="bottom"></div>
            <div class="admin-crop-box" data-crop-box>
              <span data-handle="nw"></span><span data-handle="ne"></span><span data-handle="sw"></span><span data-handle="se"></span>
            </div>
          </div>
          <div class="admin-crop-modal__actions">
            <button type="button" class="admin-secondary" data-crop-cancel>Cancel</button>
            <button type="button" class="admin-secondary" data-crop-original>Use original</button>
            <button type="button" class="admin-button" data-crop-save>Save crop</button>
          </div>
        </div>
      </div>`);

    const modal = document.getElementById("adminCropModal")!;
    const box = modal.querySelector<HTMLElement>("[data-crop-box]")!;
    const shades = {
      top: modal.querySelector<HTMLElement>('[data-shade="top"]')!,
      left: modal.querySelector<HTMLElement>('[data-shade="left"]')!,
      right: modal.querySelector<HTMLElement>('[data-shade="right"]')!,
      bottom: modal.querySelector<HTMLElement>('[data-shade="bottom"]')!,
    };

    const paint = () => {
      box.style.transform = `translate(${crop.x}px, ${crop.y}px)`;
      box.style.width = `${crop.w}px`;
      box.style.height = `${crop.h}px`;
      shades.top.style.height = `${crop.y}px`;
      shades.left.style.top = `${crop.y}px`;
      shades.left.style.height = `${crop.h}px`;
      shades.left.style.width = `${crop.x}px`;
      shades.right.style.top = `${crop.y}px`;
      shades.right.style.height = `${crop.h}px`;
      shades.right.style.width = `${Math.max(0, displayW - crop.x - crop.w)}px`;
      shades.bottom.style.height = `${Math.max(0, displayH - crop.y - crop.h)}px`;
    };
    paint();

    type DragMode = "move" | "nw" | "ne" | "sw" | "se";
    let drag: { mode: DragMode; startX: number; startY: number; origin: Rect } | null = null;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      const handle = target.getAttribute("data-handle") as DragMode | null;
      const mode = (handle || (target.closest("[data-crop-box]") ? "move" : "")) as DragMode | "";
      if (!mode) return;
      event.preventDefault();
      drag = { mode, startX: event.clientX, startY: event.clientY, origin: { ...crop } };
      stage.setPointerCapture?.(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!drag) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      const o = drag.origin;
      if (drag.mode === "move") {
        crop = {
          x: clamp(o.x + dx, 0, displayW - o.w),
          y: clamp(o.y + dy, 0, displayH - o.h),
          w: o.w,
          h: o.h,
        };
      } else {
        let x = o.x;
        let y = o.y;
        let w = o.w;
        let h = o.h;
        if (drag.mode.includes("w")) {
          const nextX = clamp(o.x + dx, 0, o.x + o.w - minSize);
          w = o.w + (o.x - nextX);
          x = nextX;
        }
        if (drag.mode.includes("e")) w = clamp(o.w + dx, minSize, displayW - o.x);
        if (drag.mode.includes("n")) {
          const nextY = clamp(o.y + dy, 0, o.y + o.h - minSize);
          h = o.h + (o.y - nextY);
          y = nextY;
        }
        if (drag.mode.includes("s")) h = clamp(o.h + dy, minSize, displayH - o.y);
        crop = { x, y, w, h };
      }
      paint();
    };

    const onPointerUp = () => { drag = null; };

    const stage = modal.querySelector<HTMLElement>(".admin-crop-stage")!;
    stage.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    const finish = (result: File | null) => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      URL.revokeObjectURL(url);
      modal.remove();
      resolve(result);
    };

    modal.querySelector("[data-crop-cancel]")?.addEventListener("click", () => finish(null));
    modal.querySelector("[data-crop-original]")?.addEventListener("click", () => finish(file));
    modal.querySelector("[data-crop-save]")?.addEventListener("click", async () => {
      const sx = crop.x / scale;
      const sy = crop.y / scale;
      const sw = crop.w / scale;
      const sh = crop.h / scale;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sw));
      canvas.height = Math.max(1, Math.round(sh));
      const ctx = canvas.getContext("2d");
      if (!ctx) return finish(file);
      ctx.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      const { mime, ext, quality } = outputType(file);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, mime, quality));
      if (!blob) return finish(file);
      finish(new File([blob], renameCropped(file, ext), { type: mime, lastModified: Date.now() }));
    });
  });
}

export async function cropImageFiles(files: File[]): Promise<File[]> {
  const cropped: File[] = [];
  for (const file of files) {
    const next = await cropImageFile(file);
    if (next) cropped.push(next);
  }
  return cropped;
}
