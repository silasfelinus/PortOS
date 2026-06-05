import { useRef, useEffect } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { getPreset, stepFly } from '../../utils/cityPhotoMode';

// Photo-mode camera driver (roadmap 3.3 / 3.6). When photo mode is active this flies the camera
// to the selected cinematic preset with a smooth ease, and registers a capture function with the
// page (via `onReady`) that grabs the current WebGL frame as a PNG data URL. It renders nothing
// itself — it only mutates the shared camera and forces an on-demand render before each capture
// so `preserveDrawingBuffer` has a fresh frame to read. Mirrors CameraTransition's ease/lerp.
//
// In photo mode the Canvas runs frameloop="demand" (roadmap 3.6 animation-pause): the scene
// animates only while the camera is flying, then freezes for a clean, deliberate still. Because
// "demand" stops ticking useFrame on its own, this component pumps the loop via `invalidate()` —
// once when a fly begins (activation / preset change) and again every frame until the fly
// settles. After that nothing invalidates, so the scene holds frozen until the next fly.

export default function CityPhotoCamera({ active, presetId, onReady }) {
  const { camera, gl, scene, invalidate } = useThree();
  const progressRef = useRef(1);
  const startPosRef = useRef(new THREE.Vector3());
  const startTargetRef = useRef(new THREE.Vector3());
  const lastPresetRef = useRef(null);
  const wasActiveRef = useRef(false);

  // Register the capture function with the page. Reading the canvas requires the renderer to
  // have been created with preserveDrawingBuffer:true (set on the Canvas gl prop). We force one
  // synchronous render of the current scene/camera first so the buffer matches what's on screen
  // even when the frameloop is paused ("demand") in photo mode.
  useEffect(() => {
    if (!onReady) return;
    const capture = () => {
      gl.render(scene, camera);
      return gl.domElement.toDataURL('image/png');
    };
    onReady(capture);
    return () => onReady(null);
  }, [onReady, gl, scene, camera]);

  // Begin a fly whenever photo mode turns on or the preset changes. Kick the demand loop once so
  // useFrame starts ticking again even though the scene is otherwise frozen.
  const beginFly = () => {
    progressRef.current = 0;
    startPosRef.current.copy(camera.position);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    startTargetRef.current.copy(camera.position).add(dir.multiplyScalar(10));
    invalidate();
  };

  useFrame((_, delta) => {
    if (!active) {
      wasActiveRef.current = false;
      lastPresetRef.current = null;
      return;
    }
    // Detect activation or preset change → start a new fly from the current pose.
    if (!wasActiveRef.current || lastPresetRef.current !== presetId) {
      wasActiveRef.current = true;
      lastPresetRef.current = presetId;
      beginFly();
    }
    if (progressRef.current >= 1) return; // settled — leave the camera where the fly left it, scene frozen

    const { progress, t, done } = stepFly(progressRef.current, delta);
    progressRef.current = progress;

    const preset = getPreset(presetId);
    const endPos = new THREE.Vector3(...preset.position);
    const endTarget = new THREE.Vector3(...preset.target);

    camera.position.lerpVectors(startPosRef.current, endPos, t);
    camera.lookAt(new THREE.Vector3().lerpVectors(startTargetRef.current, endTarget, t));

    // In frameloop="demand" the loop sleeps after this frame unless something requests another.
    // Keep pumping until the fly settles; once done, stop so the scene freezes for the shot.
    if (!done) invalidate();
  });

  return null;
}
