import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import { PIXEL_FONT_URL } from './cityConstants';
import { computeGoalMonuments, MONUMENTS } from '../../utils/cityGoalMonuments';

// CyberCity's goal monuments (roadmap 2.7): each life goal is a structure in a
// northeast monument district (a row centered around [30,0,-40]). Active goals are
// construction sites — a solid built base topped by a translucent scaffold cage whose
// fill tracks progress. Completed goals are polished, fully-built monuments that shimmer.
// Stalled (active-but-quiet) and abandoned goals read dim. Goals past the cap fold into
// an overflow marker. Mirrors CityBackupVault / CityHealthTower.
function Monument({ monument, shimmerRef, isShimmer }) {
  const { height, width, color, opacity, intensity, built, completeness, position } = monument;
  // The "built" portion rises from the ground; the remaining height is scaffold.
  const builtHeight = Math.max(0.4, height * (built ? 1 : completeness));
  const scaffoldHeight = Math.max(0, height - builtHeight);

  return (
    <group position={position}>
      {/* Plinth */}
      <mesh position={[0, 0.2, 0]}>
        <boxGeometry args={[width * 1.4, 0.4, width * 1.4]} />
        <meshStandardMaterial color="#0a0e16" emissive={color} emissiveIntensity={0.1 * intensity + 0.04} metalness={0.6} roughness={0.5} />
      </mesh>

      {/* Built portion — solid structure; completed monuments shimmer via ref */}
      <mesh ref={isShimmer ? shimmerRef : undefined} position={[0, 0.4 + builtHeight / 2, 0]}>
        <boxGeometry args={[width, builtHeight, width]} />
        <meshStandardMaterial
          color={built ? '#0d1a12' : '#0c1424'}
          emissive={color}
          emissiveIntensity={intensity}
          metalness={built ? 0.7 : 0.4}
          roughness={built ? 0.35 : 0.6}
          transparent={opacity < 1}
          opacity={opacity}
          toneMapped={false}
        />
      </mesh>

      {/* Scaffold cage over the still-unbuilt portion of a construction site */}
      {scaffoldHeight > 0.3 && (
        <mesh position={[0, 0.4 + builtHeight + scaffoldHeight / 2, 0]}>
          <boxGeometry args={[width * 1.05, scaffoldHeight, width * 1.05]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={intensity * 0.5} wireframe transparent opacity={opacity * 0.6} toneMapped={false} />
        </mesh>
      )}

      {/* Title + progress label above the structure */}
      <Text position={[0, height + 1.4, 0]} fontSize={0.7} color={color} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={9} fillOpacity={opacity}>
        {monument.title}
      </Text>
      <Text position={[0, height + 0.7, 0]} fontSize={0.55} color="#94a3b8" anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={9} fillOpacity={opacity}>
        {built ? 'COMPLETE' : `${Math.round(monument.progress)}%`}
      </Text>
    </group>
  );
}

export default function CityGoalMonuments({ goals, settings }) {
  // The API returns `{ goals: [...] }`; accept either the wrapper or a bare array.
  const list = Array.isArray(goals) ? goals : goals?.goals;
  const district = useMemo(() => computeGoalMonuments(list), [list]);
  const shimmerRef = useRef();

  // Honor the quality dial: drop the completed-monument shimmer on the lowest preset,
  // but keep the static glow so each goal's status stays legible.
  const animate = (settings?.particleDensity ?? 1) >= 0.5;

  // Pick the first completed monument to carry the shimmer (one per-frame ref mutation).
  const shimmerIndex = useMemo(
    () => district.monuments.findIndex((m) => m.built),
    [district.monuments],
  );

  useFrame(({ clock }) => {
    if (!animate || !shimmerRef.current || shimmerIndex < 0) return;
    const base = district.monuments[shimmerIndex].intensity;
    const pulse = (Math.sin(clock.getElapsedTime() * 1.6) + 1) / 2; // 0..1
    shimmerRef.current.material.emissiveIntensity = base + pulse * 0.5;
  });

  if (!district.hasData) return null;

  const { base, monuments, overflow, total, completedCount } = district;

  return (
    <group>
      {monuments.map((monument, i) => (
        <Monument
          key={monument.id}
          monument={monument}
          shimmerRef={shimmerRef}
          isShimmer={i === shimmerIndex}
        />
      ))}

      {/* Overflow marker — "+N MORE" past the end of the row */}
      {overflow && (
        <group position={overflow.position}>
          <mesh position={[0, MONUMENTS.minHeight / 2, 0]}>
            <boxGeometry args={[MONUMENTS.baseWidth, MONUMENTS.minHeight, MONUMENTS.baseWidth]} />
            <meshStandardMaterial color="#0c1424" emissive="#64748b" emissiveIntensity={0.2} metalness={0.5} roughness={0.6} />
          </mesh>
          <Text position={[0, MONUMENTS.minHeight + 1, 0]} fontSize={0.6} color="#94a3b8" anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={9}>
            {`+${overflow.count} MORE`}
          </Text>
        </group>
      )}

      {/* District title behind the row */}
      <Text position={[base[0], 16, base[2] - 3]} fontSize={1.4} color="#22c55e" anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={30}>
        GOALS
      </Text>
      <Text position={[base[0], 15, base[2] - 3]} fontSize={0.8} color="#94a3b8" anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={30}>
        {`${completedCount}/${total} ACHIEVED`}
      </Text>
    </group>
  );
}
