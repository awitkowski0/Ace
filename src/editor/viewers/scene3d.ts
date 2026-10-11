/** Shared three.js scaffolding for the glTF and Blockbench viewers. three.js is imported lazily (own chunk). */
import type * as T from "three";

export interface SceneKit {
  THREE: typeof T;
  scene: T.Scene;
  camera: T.PerspectiveCamera;
  renderer: T.WebGLRenderer;
  controls: import("three/examples/jsm/controls/OrbitControls.js").OrbitControls;
  grid: T.GridHelper;
  render(): void;
  /** frame `obj` (or the whole scene content) in view */
  frame(obj: T.Object3D): void;
  setWire(on: boolean): void;
  /** call `tick(dt)` every animation frame while on */
  animate(on: boolean, tick?: (dt: number) => void): void;
  dispose(): void;
}

export async function createScene(container: HTMLElement): Promise<SceneKit> {
  const THREE = await import("three");
  const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
  const css = getComputedStyle(document.documentElement);
  const bg = css.getPropertyValue("--bg-editor").trim() || "#2e3440";
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(new THREE.Color(bg));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.cssText = "display:block;width:100%;height:100%;outline:none";
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
  camera.position.set(2, 1.6, 3);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(3, 6, 4);
  scene.add(sun);
  const grid = new THREE.GridHelper(10, 20, 0x677088, 0x3b4252);
  scene.add(grid);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;

  let pending = 0;
  let animating = false;
  let tickFn: ((dt: number) => void) | undefined;
  let last = 0;
  let dead = false;
  const render = () => { if (!dead) renderer.render(scene, camera); };
  const request = () => {
    if (pending || animating || dead) return;
    pending = requestAnimationFrame(() => { pending = 0; render(); });
  };
  controls.addEventListener("change", request);
  const loop = (now: number) => {
    if (!animating || dead) return;
    tickFn?.((now - last) / 1000);
    last = now;
    render();
    requestAnimationFrame(loop);
  };
  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    request();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  return {
    THREE, scene, camera, renderer, controls, grid,
    render: request,
    frame(obj) {
      const box = new THREE.Box3().setFromObject(obj);
      if (box.isEmpty()) return;
      const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
      const r = Math.max(size.x, size.y, size.z) || 1;
      const dist = (r / 2 / Math.tan((camera.fov * Math.PI) / 360)) * 1.6;
      camera.near = r / 500; camera.far = r * 200;
      camera.position.copy(center).add(new THREE.Vector3(0.8, 0.6, 1).normalize().multiplyScalar(dist));
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();
      grid.position.y = box.min.y;
      grid.scale.setScalar(Math.max(1, r / 5));
      request();
    },
    setWire(on) {
      scene.traverse((o) => {
        const m = (o as T.Mesh).material as T.Material | T.Material[] | undefined;
        if (!m) return;
        for (const x of Array.isArray(m) ? m : [m]) (x as T.MeshStandardMaterial).wireframe = on;
      });
      request();
    },
    animate(on, tick) {
      animating = on; tickFn = tick;
      if (on) { last = performance.now(); requestAnimationFrame(loop); } else request();
    },
    dispose() {
      dead = true;
      ro.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        const m = o as T.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as T.Material | T.Material[] | undefined;
        for (const x of mat ? (Array.isArray(mat) ? mat : [mat]) : []) {
          for (const v of Object.values(x)) (v as T.Texture | undefined)?.isTexture && (v as T.Texture).dispose();
          x.dispose();
        }
      });
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
