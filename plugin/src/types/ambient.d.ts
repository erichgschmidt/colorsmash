declare module "photoshop" {
  export const app: any;
  export const action: any;
  export const imaging: any;
  export const core: any;
}
declare module "uxp" {
  const uxp: any;
  export = uxp;
}

// Compile-time flag injected by webpack DefinePlugin. True in the Pro build
// (`npm run build:pro`), false in the free build (`npm run build` / `build:free`).
// References to this constant fold to a literal at build time, so the false
// branch of `__SMASH_ENABLED__ ? ... : ...` is dead-code-eliminated by terser
// in production. See ColorSmash_Masterplan_v1.md §2.3.
declare const __SMASH_ENABLED__: boolean;
