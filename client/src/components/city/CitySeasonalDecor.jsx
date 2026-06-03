import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import { PIXEL_FONT_URL } from './cityConstants';
import { computeSeasonalDecor, SEASONAL_DECOR } from '../../utils/citySeasonalDecor';

// CyberCity's seasonal decorations (roadmap 3.5 follow-up, #824): date-driven city dressing
// that layers the active season's (or holiday's) palette onto a loose ring of glowing accent
// props around the city's edge. The theme is resolved from a date passed in — a holiday window
// (New Year, Halloween, …) overrides the broad season. Props bob/shimmer in unison via a single
// per-frame group ref, gated on the quality dial (mirrors CityArtifacts / CityGoalMonuments).
function Decoration({ decoration, color, accent }) {
  const { position } = decoration;
  const s = SEASONAL_DECOR.propSize;

  return (
    <group position={position}>
      {/* A faceted, glowing prop — abstract enough to read for any season/holiday. */}
      <mesh position={[0, s * 0.6, 0]} rotation={[0, Math.PI / 5, 0]}>
        <coneGeometry args={[s * 0.5, s * 1.4, 5]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.55} metalness={0.4} roughness={0.3} toneMapped={false} />
      </mesh>

      {/* An accent orb crowns the prop — the holiday/season's secondary color. */}
      <mesh position={[0, s * 1.5, 0]}>
        <sphereGeometry args={[s * 0.28, 10, 10]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.8} toneMapped={false} />
      </mesh>

      <pointLight position={[0, s * 1.2, 0]} color={accent} intensity={0.7} distance={9} />
    </group>
  );
}

export default function CitySeasonalDecor({ date, settings }) {
  // Resolve the active theme once per (date, calendar-day) — `date` is injected so the season is
  // deterministic (and unit-testable in the helper). Default to the current moment for the live
  // app; tests drive the pure helper directly, never this component's default.
  const decor = useMemo(() => computeSeasonalDecor(date ?? new Date()), [date]);

  const groupRef = useRef();

  // Honor the quality dial: drop the bob/shimmer on the lowest preset, but keep the static glow
  // so the seasonal dressing stays visible.
  const animate = (settings?.particleDensity ?? 1) >= 0.5;

  useFrame(({ clock }) => {
    if (!animate || !groupRef.current) return;
    const t = clock.getElapsedTime();
    const pulse = (Math.sin(t * 1.1) + 1) / 2; // 0..1
    groupRef.current.scale.setScalar(1 + pulse * 0.06);
    groupRef.current.position.y = pulse * 0.6; // gentle bob
  });

  if (!decor.hasData) return null;

  const { decorations, color, accent, label, base = [0, 0, 0] } = decor;

  return (
    <group>
      <group ref={groupRef}>
        {decorations.map((decoration) => (
          <Decoration key={decoration.id} decoration={decoration} color={color} accent={accent} />
        ))}
      </group>

      {/* Season/holiday banner high above the city center so it reads as ambient context. */}
      <Text position={[base[0], 34, base[2]]} fontSize={1.6} color={color} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={40}>
        {label}
      </Text>
    </group>
  );
}
