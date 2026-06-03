import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import { PIXEL_FONT_URL } from './cityConstants';
import { computeEasterEggs, EGGS } from '../../utils/cityEasterEggs';

// CyberCity's easter eggs (roadmap 3.5 follow-up, #824): rare, hidden emblems that only appear
// when a special condition is met (a developer's date, a "leet" level, a palindrome streak, a
// clean-sweep goal board). Tucked in a quiet far corner so they read as a discovery, not a
// featured district. Each egg is a small glowing icosahedron with a tiny glyph label; they bob
// in unison via a single per-frame group ref, gated on the quality dial (mirrors CityArtifacts).
function Egg({ egg }) {
  const { color, label, position } = egg;
  const s = EGGS.size;

  return (
    <group position={position}>
      <mesh rotation={[0, Math.PI / 6, 0]}>
        <icosahedronGeometry args={[s, 0]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.9} metalness={0.6} roughness={0.2} toneMapped={false} />
      </mesh>

      <pointLight color={color} intensity={1.1} distance={8} />

      {/* Tiny glyph so the egg hints at what it is without spelling it out. */}
      <Text position={[0, s + 0.5, 0]} fontSize={0.45} color={color} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={6}>
        {label}
      </Text>
    </group>
  );
}

export default function CityEasterEggs({ date, character, goals, productivityData, settings }) {
  // Resolve unlocked eggs from the data the city already has + an injected date (deterministic in
  // the helper's tests). Default to the current moment for the live app only.
  const cluster = useMemo(
    () => computeEasterEggs({ date: date ?? new Date(), character, goals, productivityData }),
    [date, character, goals, productivityData],
  );

  const groupRef = useRef();

  // Honor the quality dial: drop the bob on the lowest preset, keep the static glow.
  const animate = (settings?.particleDensity ?? 1) >= 0.5;

  useFrame(({ clock }) => {
    if (!animate || !groupRef.current) return;
    const pulse = (Math.sin(clock.getElapsedTime() * 2) + 1) / 2; // 0..1, faster = rarer/twinkly
    groupRef.current.position.y = pulse * 0.4;
    groupRef.current.rotation.y = clock.getElapsedTime() * 0.3;
  });

  if (!cluster.hasData) return null;

  const { base, eggs } = cluster;

  return (
    <group>
      <group ref={groupRef}>
        {eggs.map((egg) => (
          <Egg key={egg.id} egg={egg} />
        ))}
      </group>

      {/* A faint marker so a found cluster has a label, kept small to preserve the "hidden" feel. */}
      <Text position={[base[0], 6, base[2]]} fontSize={0.7} color="#64748b" anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={20}>
        :)
      </Text>
    </group>
  );
}
