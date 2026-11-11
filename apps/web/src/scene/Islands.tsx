'use client';

import { memo, type ReactElement } from 'react';
import type { Layout } from './layout';
import { GEO, MAT } from './shared';

function Tree({ x, z, s = 1 }: { x: number; z: number; s?: number }) {
  return (
    <group position={[x, 0, z]} scale={s}>
      <mesh geometry={GEO.trunk} material={MAT.trunk} position={[0, 0.2, 0]} />
      <mesh geometry={GEO.treeCone} material={MAT.tree} position={[0, 0.9, 0]} />
    </group>
  );
}

const RoomIsland = memo(function RoomIsland({ layout, roomId }: { layout: Layout; roomId: string }) {
  const c = layout.roomCenters[roomId];
  const R = layout.islandRadius;
  const base = (layout.roomAngles[roomId] ?? 0) + Math.PI;
  const decor: ReactElement[] = [];
  for (let k = 0; k < layout.roomSize; k++) {
    if (k % 2) continue;
    const a = base + (k / layout.roomSize) * Math.PI * 2;
    // trees sit in the world frame; group is not rotated so use cos/sin directly
    decor.push(<Tree key={k} x={Math.cos(a) * (R - 0.55)} z={Math.sin(a) * (R - 0.55)} s={0.8 + (k % 3) * 0.15} />);
  }
  return (
    <group position={c}>
      <mesh geometry={GEO.hex} material={MAT.grass} scale={[R, 0.35, R]} position={[0, -0.175, 0]} />
      <mesh geometry={GEO.hex} material={MAT.grassDark} scale={[R * 0.35, 0.37, R * 0.35]} position={[0, -0.17, 0]} />
      <mesh geometry={GEO.hexTaper} material={MAT.dirt} scale={[R * 0.99, 0.9, R * 0.99]} position={[0, -0.8, 0]} />
      <mesh
        geometry={GEO.cone6}
        material={MAT.rock}
        scale={[R * 0.84, R * 1.3, R * 0.84]}
        position={[0, -1.25 - R * 0.65, 0]}
        rotation={[Math.PI, 0, 0]}
      />
      <mesh geometry={GEO.rock} material={MAT.rock} position={[R * 0.15, 0.05, -R * 0.1]} scale={1.2} />
      {decor}
    </group>
  );
});

const CouncilIsland = memo(function CouncilIsland({ radius: R }: { radius: number }) {
  const torches: ReactElement[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
    torches.push(
      <mesh
        key={k}
        geometry={GEO.cone6}
        material={MAT.gold}
        scale={[0.25, 0.9, 0.25]}
        position={[Math.cos(a) * (R - 0.5), 0.45, Math.sin(a) * (R - 0.5)]}
      />,
    );
  }
  return (
    <group>
      <mesh geometry={GEO.hex} material={MAT.councilTop} scale={[R, 0.4, R]} position={[0, -0.2, 0]} />
      <mesh geometry={GEO.hex} material={MAT.councilInlay} scale={[R * 0.72, 0.42, R * 0.72]} position={[0, -0.2, 0]} />
      <mesh geometry={GEO.hex} material={MAT.councilTop} scale={[R * 0.62, 0.44, R * 0.62]} position={[0, -0.2, 0]} />
      <mesh geometry={GEO.hexTaper} material={MAT.councilRock} scale={[R, 1.2, R]} position={[0, -1.0, 0]} />
      <mesh
        geometry={GEO.cone6}
        material={MAT.rock}
        scale={[R * 0.85, R * 1.1, R * 0.85]}
        position={[0, -1.6 - R * 0.55, 0]}
        rotation={[Math.PI, 0, 0]}
      />
      {torches}
    </group>
  );
});

export function Islands({ layout, roomIds }: { layout: Layout; roomIds: string[] }) {
  return (
    <group>
      <CouncilIsland radius={layout.councilRadius} />
      {roomIds.map((id) => (
        <RoomIsland key={id} layout={layout} roomId={id} />
      ))}
    </group>
  );
}
