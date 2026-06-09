import { useMemo, useLayoutEffect, useRef } from 'react';
import * as THREE from 'three';
import { cityDayMix, mixHex } from './cityConstants';
import { useCityPalette } from './CityPaletteContext';
import { computeStreets, computeStreetProps } from '../../utils/cityPlan';

// Street furniture from the master plan: lamp posts pooling light along every street and
// holo-trees ringing the AI Core plaza. Everything is instanced — four draw calls cover
// the whole town regardless of lamp count. Lamp light pools are faked with emissive heads
// + additive ground discs (the city's established no-real-point-lights pattern).
// Quality-gated: the low preset renders streets only (this component returns null).

const dummy = new THREE.Object3D();

// One instanced mesh whose matrices are written once from `placements`.
function Instances({ placements, geometryArgs, geometry, position, children }) {
  const ref = useRef();
  useLayoutEffect(() => {
    if (!ref.current) return;
    placements.forEach((p, i) => {
      dummy.position.set(p.x + (position?.[0] ?? 0), position?.[1] ?? 0, p.z + (position?.[2] ?? 0));
      dummy.rotation.set(0, p.seed != null ? (p.seed * 1.7) % (Math.PI * 2) : 0, 0);
      dummy.scale.setScalar(p.scale ?? 1);
      dummy.updateMatrix();
      ref.current.setMatrixAt(i, dummy.matrix);
    });
    ref.current.instanceMatrix.needsUpdate = true;
  }, [placements, position]);

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, placements.length]} frustumCulled={false}>
      {geometry === 'cylinder' && <cylinderGeometry args={geometryArgs} />}
      {geometry === 'sphere' && <sphereGeometry args={geometryArgs} />}
      {geometry === 'circle' && <circleGeometry args={geometryArgs} />}
      {geometry === 'icosahedron' && <icosahedronGeometry args={geometryArgs} />}
      {children}
    </instancedMesh>
  );
}

// The glow discs lie flat — they need their own matrix writer with a rotation.
function FlatInstances({ placements, radius, children }) {
  const ref = useRef();
  useLayoutEffect(() => {
    if (!ref.current) return;
    placements.forEach((p, i) => {
      dummy.position.set(p.x, 0.035, p.z);
      dummy.rotation.set(-Math.PI / 2, 0, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      ref.current.setMatrixAt(i, dummy.matrix);
    });
    ref.current.instanceMatrix.needsUpdate = true;
  }, [placements]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, placements.length]} frustumCulled={false}>
      <circleGeometry args={[radius, 16]} />
      {children}
    </instancedMesh>
  );
}

export default function CityStreetProps({ settings }) {
  const { accent, tintStructure } = useCityPalette();
  const dayMix = cityDayMix(settings);
  const density = settings?.particleDensity ?? 1;

  const props = useMemo(() => {
    const streets = computeStreets();
    return computeStreetProps(streets, density);
  }, [density]);

  // Low preset: streets only, no furniture.
  if (density <= 0.5 || (props.lamps.length === 0 && props.trees.length === 0)) return null;

  const lampGlow = mixHex(accent, '#fff7d6', 0.35);
  const headOpacity = 0.95 * (1 - dayMix) + 0.4 * dayMix; // lamps rest by day
  const poolOpacity = 0.1 * (1 - dayMix); // light pools are a night thing

  return (
    <group>
      {/* Lamp poles */}
      <Instances placements={props.lamps} geometry="cylinder" geometryArgs={[0.05, 0.08, 3.4, 6]} position={[0, 1.7, 0]}>
        <meshStandardMaterial color={tintStructure('#141b2c')} roughness={0.7} metalness={0.45} />
      </Instances>
      {/* Lamp heads — emissive spheres standing in for point lights */}
      <Instances placements={props.lamps} geometry="sphere" geometryArgs={[0.16, 10, 10]} position={[0, 3.45, 0]}>
        <meshBasicMaterial color={lampGlow} transparent opacity={headOpacity} toneMapped={false} />
      </Instances>
      {/* Faked light pools on the pavement */}
      {poolOpacity > 0.005 && (
        <FlatInstances placements={props.lamps} radius={1.7}>
          <meshBasicMaterial
            color={lampGlow}
            transparent
            opacity={poolOpacity}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </FlatInstances>
      )}
      {/* Holo-tree trunks around the plaza */}
      <Instances placements={props.trees} geometry="cylinder" geometryArgs={[0.07, 0.1, 1.1, 5]} position={[0, 0.55, 0]}>
        <meshStandardMaterial color={tintStructure('#101626')} roughness={0.8} />
      </Instances>
      {/* Holo-tree canopies — wireframe polyhedra, the city's "digital foliage" */}
      <Instances placements={props.trees} geometry="icosahedron" geometryArgs={[0.8, 1]} position={[0, 1.9, 0]}>
        <meshBasicMaterial
          color={mixHex(accent, '#22c55e', 0.45)}
          wireframe
          transparent
          opacity={0.5 * (1 - dayMix) + 0.3 * dayMix}
          toneMapped={false}
        />
      </Instances>
    </group>
  );
}
