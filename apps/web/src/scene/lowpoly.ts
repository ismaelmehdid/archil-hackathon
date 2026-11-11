import type * as THREE from 'three';

/**
 * Stylised low-poly shading, patched into MeshStandardMaterial (flatShading):
 *  - per-facet brightness jitter (from the world-space facet normal, so it is stable while the camera orbits),
 *  - a soft pastel rim light that outlines silhouettes,
 *  - a warm top / cool bottom tint so facets read clearly.
 * One shared function => three.js caches ONE program per material variant (no extra shader compiles).
 */
function lowPolyCompile(shader: { fragmentShader: string }) {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <opaque_fragment>',
    /* glsl */ `
    {
      vec3 lpN = normalize(inverseTransformDirection(normal, viewMatrix));
      float lpJ = 0.5 + 0.5 * sin(dot(lpN, vec3(17.13, 31.71, 23.37)));
      outgoingLight *= 0.93 + 0.14 * lpJ;
      outgoingLight *= mix(vec3(0.93, 0.92, 1.04), vec3(1.04, 1.02, 0.97), lpN.y * 0.5 + 0.5);
      float lpRim = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
      outgoingLight += vec3(1.0, 0.88, 0.96) * lpRim * 0.16;
    }
    #include <opaque_fragment>`,
  );
}

export function lowPoly<T extends THREE.Material>(m: T): T {
  m.onBeforeCompile = lowPolyCompile as unknown as THREE.Material['onBeforeCompile'];
  m.customProgramCacheKey = () => 'lowpoly';
  return m;
}
