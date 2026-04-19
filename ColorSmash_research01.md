Building a Modern Photoshop Plugin
Executive Summary
For a new plugin in 2026, the default choice should be UXP, not CEP. Adobe positions UXP plugins as the modern, actively developed path for Photoshop v22.0 and later, while explicitly steering Photoshop 2020 v21 and earlier toward CEP, ExtendScript, or the C++ SDK. CEP is still usable, but Adobe stated in late 2024 that CEP 12 would be its last major update, with only critical security fixes planned after that. Native C++ plugins remain important for low-level integrations such as filters, file formats, and deeper selector-style capabilities. 

A pragmatic baseline for new work is: support Photoshop 23.3+ if you want Manifest v5 permissions and WebViews; support 24.4+ if you want Spectrum Web Components with the current documented path; support 24.2+ if you expect to need Hybrid plugins or the Imaging API. For most commercial plugins aimed at broad adoption, a panel-plus-command UXP architecture with Manifest v5, DOM-first host calls, and batchPlay only where the DOM is incomplete is the best balance of capability, maintainability, and distribution simplicity. 

Your uploaded brief points to a sophisticated future color-matching use case. Even though this report stays feature-agnostic, that kind of workload is exactly where the architecture decision matters most: simple UI and orchestration can stay in UXP, while heavy pixel math may justify the Imaging API, WebAssembly, or a Hybrid/C++ module, depending on performance and platform requirements. 
 

The highest-level recommendation is therefore straightforward: start with a UXP panel and one or more headless command entrypoints; keep your UI Spectrum-based and theme-aware; isolate Photoshop host calls behind a small service layer; store only minimal permissions in the manifest; package as a .ccx; and move to Hybrid or pure C++ only if you can prove you need native compute or true Photoshop-native plugin surfaces such as filters or file-format handlers. 

Frameworks and Compatibility
Photoshop now has three meaningful extensibility tracks: modern UXP plugins, legacy CEP/ExtendScript, and the C++ SDK. Their overlap is real, but their intended use is not the same. UXP is best for panels, dialogs, commands, local storage, networked workflows, and most automation. CEP is now primarily a legacy-compatibility choice. The C++ SDK is for true low-level host integration. Hybrid plugins sit between them, bundling UXP UI with native code. 

Photoshop versions	Primary framework stance	Feature gates that matter	Recommendation	Evidence
2020 v21 and earlier	UXP is not the documented path; use CEP, ExtendScript, and/or C++ SDK	Legacy only	Use only if you must support older customer fleets	
2021 v22.0–22.x	UXP plugins exist, but older host/API behavior is more constrained	Sample repo starts at PS 22.0; targeting <23.0 defaults apiVersion to 1	Support only if older users materially matter to you	
2022-era modern baseline v23.0+	UXP becomes the real production baseline	apiVersion: 2 is the modal JavaScript model; default when minVersion >= 23.0; apiVersion: 1 is deprecated	Good minimum if you do not need Manifest v5	
v23.1+	UXP gains startup loading control	loadEvent supports use and startup	Use startup only for listeners/background connectivity	
v23.3+	Modern Manifest v5 era	New permissions model; WebViews in modal dialogs; full Manifest v5 feature set requires PS 23.3+	Best general-purpose floor for new plugins	
v24.2+	UXP Hybrid and Imaging API arrive	Hybrid minimum is 24.2; Imaging API beta begins here	Good floor for compute-heavy plugins	
v24.4+	SWC-forward UI becomes practical	SWC docs require Manifest v5, enableSWCSupport, and minVersion: 24.4 in the documented starter path	Best floor if you want a modern component strategy	
v25.0–25.1+	Better workflow integration	Action recording support lands; Creative Cloud user GUID permission appears at 25.1	Valuable if Actions integration or user identity is important	
Ongoing legacy status	CEP still works but is no longer where innovation is happening	CEP 12 is the last major update; critical security fixes only	Avoid for greenfield work unless legacy support is the requirement	

A second compatibility question is platform scope. Pure UXP HTML/CSS/JS plugins are usually the easiest path to a single cross-platform codebase for Windows and macOS. The moment you add native code, the matrix changes: hybrid distribution docs require you to validate Mac M1, Mac Intel, and Windows Intel, and Adobe’s Apple Silicon guidance says C++ plugins must be recompiled for ARM-based architectures. 

Manifest fields and permissions that matter
Manifest design is not paperwork; it is your security model, compatibility declaration, menu surface, and lifecycle contract. Manifest v5 adds the permissions model and promise-aware entrypoint lifecycle, and should be your default if you can set host.minVersion to at least 23.3. 

Field	Why it matters	Practical guidance	Evidence
manifestVersion	Enables newer runtime features	Use 5 for new work if your minimum Photoshop is 23.3+	
host.app and host.minVersion	Declares host compatibility	Use PS; set the minimum to the oldest version you truly test	
host.data.apiVersion	Selects Photoshop API behavior	Use apiVersion: 2; version 1 is deprecated	
host.data.loadEvent	Controls lazy vs startup load	Default use; switch to startup only for listeners or persistent connectivity	
entrypoints	Defines commands and panels	Use commands for one-shot automation; panels for persistent UI	
requiredPermissions.network	Declares allowed domains	Whitelist only exact domains you need	
requiredPermissions.localFileSystem	Governs file access	Prefer request; avoid fullAccess unless the product absolutely needs it	
requiredPermissions.launchProcess	Needed for openExternal and openPath	Scope URI schemes and file extensions narrowly; calls still trigger runtime consent	
requiredPermissions.webview	Enables <webview>	Use only when you truly need embedded HTML; WebViews are dialog-only in current Photoshop docs	
requiredPermissions.clipboard, ipc, enableUserInfo	Optional surface expansion	Add only when the feature exists in the product	

UI Models and Architecture Options
Photoshop’s own design guidance is unusually clear: use a panel when the user must keep interacting with the canvas, and use a dialog when the user is parameterizing an action and does not need to keep changing the document while the UI remains open. Headless commands are best when the action is direct, predictable, and menu- or Actions-driven. Panels are the most powerful but also the closest thing to building a small application inside Photoshop. 

There is also an important negative capability: UXP gives you commands, panels, dialogs, and scripting-style host access, but not a first-class “custom tool” entrypoint comparable to native Photoshop tools. If you need something that behaves like a true Filter-menu plugin, file-format handler, or other deeper native extension point, the Photoshop C++ SDK is the right surface, possibly wrapped by a Hybrid UXP UI. 

A subtle UX trap is that an HTML <dialog> by itself does not automatically put Photoshop into the host’s document-locking modal state. Adobe documents a Photoshop-specific showModal({ lockDocumentFocus: true }) option for that case. In practice, treat host modality and DOM modality as two related but different concerns. 

Optional acceleration

UXP Panel or Command

State and Controller Layer

Photoshop DOM API

batchPlay descriptors

action/core event listeners

UXP storage and file tokens

fetch OAuth WebSocket or helper app

Photoshop host

plugin temp data external files

WASM or Imaging API

Hybrid C++ module



Show code
The diagram above reflects the healthiest separation for most teams: keep the UI and product logic separate from host-invocation details, and isolate batchPlay into a small, testable adapter layer. That structure matters because DOM coverage is incomplete, batchPlay descriptors are harder to maintain, and native acceleration should remain optional rather than infecting the whole codebase. 

Recommended architecture options with pros and cons
Architecture	Best for	Pros	Cons	Evidence
Vanilla UXP panel plus command entrypoints	Simple and medium-complexity plugins	Lowest complexity; easiest packaging; easiest onboarding; closest to official quickstarts and vanilla samples	More manual state management; large UIs can get messy	
TypeScript plus React plus SWC	Complex panels, settings-heavy workflows, multi-view apps	Cleaner UI state management; typed host adapters; official React, SWC, and TypeScript starter samples exist; source maps are supported in UDT	Build pipeline complexity; SWC requires feature flags/version floor	
Vue or Svelte UXP panel	Teams already fluent in those frameworks	Official sample starters exist; good option when team skill is framework-specific	Fewer Photoshop-specific examples in the docs than React/vanilla	
UXP plus WebAssembly	CPU-heavy but still mostly self-contained logic	Keeps distribution simpler than Hybrid; official Rust/WASM sample exists	Browser assumptions can fail in UXP; careful runtime validation required	
UXP Hybrid with C++	Heavy image math, OpenCV, low-latency native reuse	Native performance; reuse of mature C++ libs; bundled JS/native communication is better than older two-plugin pairings	Highest complexity; per-architecture builds; macOS signing/notarization; admin prompts at install/update	
Pure C++ SDK, optionally with UXP front-end	True filters, file formats, deeper native integration	Only path for certain native surfaces; strongest host integration	Least web-dev-friendly; hardest build and release pipeline	

For an intermediate web developer without a pre-existing native codebase, the most rational sequence is: start with Vanilla UXP or TypeScript/React/SWC; add batchPlay only when DOM coverage is missing; add WASM if you need compute but want to stay in a single artifact; and move to Hybrid or C++ only after profiling proves the need. That sequence aligns with Adobe’s current investment and with the sample repository’s center of gravity. 

Host Communication, Files, and Common Code Patterns
The modern host bridge is a layered API stack. At the top is the Photoshop DOM, exposed through require("photoshop").app and its related classes. That should be your first choice because it is more readable and more stable than raw descriptors. Underneath it is action.batchPlay, which Adobe describes as the advanced escape hatch for features not yet surfaced in the DOM. All meaningful document-mutating work should be designed around executeAsModal in the apiVersion 2 world. 

Events are similarly split: action.addNotificationListener is for document-altering Photoshop events, while core.addNotificationListener is for UI and OS-level events. Adobe’s event-listener docs also make an important development-only point: app.eventNotifier can help you discover events while building, but the catch-all mechanism is not available for production use. If you want your plugin to integrate with the Actions panel, use enableMenuRecording for command entrypoints and action.recordAction for custom recorded steps. 

File I/O in UXP is safer than old CEP-style filesystem usage, but it is also more opinionated. The plugin folder is read-only, the temp folder is ephemeral, the data folder is persistent across host upgrades, and external filesystem access is mediated through user consent and tokenized file entries. Persistent tokens are extremely useful for “remember this folder” workflows, but Adobe explicitly warns they can become invalid if files move or permissions change, so your code must degrade gracefully and re-prompt. 

Do not assume every active document has a usable native path. Adobe’s Photoshop API changelog notes that Document.path can be either a filesystem path or a cloud identifier, which means file-adjacent export, metadata, and sidecar workflows should be designed around explicit user-selected Entry objects rather than around inferred OS paths. Also do not hardcode separators or raw paths unless you have to; UXP supplies path utilities and Entry-centric APIs for a reason. 

Minimal Manifest v5 skeleton
This skeleton reflects the safest modern starting point: one panel, one command, apiVersion 2 semantics, and only narrow permissions. It assumes a target floor of Photoshop 23.3+, which is the documented baseline for full Manifest v5 features. 

json
Copy
{
  "manifestVersion": 5,
  "id": "com.example.myplugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "main": "index.html",
  "host": {
    "app": "PS",
    "minVersion": "23.3.0",
    "data": {
      "apiVersion": 2,
      "loadEvent": "use",
      "enableMenuRecording": true
    }
  },
  "entrypoints": [
    {
      "type": "panel",
      "id": "mainPanel",
      "label": {
        "default": "My Plugin"
      }
    },
    {
      "type": "command",
      "id": "runQuickAction",
      "label": {
        "default": "Run Quick Action"
      }
    }
  ],
  "requiredPermissions": {
    "network": {
      "domains": ["https://api.example.com"]
    },
    "localFileSystem": "request",
    "clipboard": "read"
  }
}
Open an image
For opening files, prefer app.open(entry) with a user-selected Entry. Adobe’s filesystem docs note that the DOM will convert file entries to the host token form automatically when needed, which is cleaner than manually constructing session tokens unless you are calling low-level batchPlay yourself. 

javascript
Copy
const { app } = require("photoshop");
const { storage } = require("uxp");

async function openImageViaPicker() {
  const fs = storage.localFileSystem;
  const entry = await fs.getFileForOpening({
    types: ["psd", "psb", "jpg", "jpeg", "png", "tif", "tiff"]
  });

  if (!entry) {
    return null;
  }

  const document = await app.open(entry);
  return document;
}
Apply a filter with batchPlay
This is the essential pattern for DOM gaps: put the operation inside executeAsModal, give it a readable commandName, and keep the descriptor isolated in one function. Adobe explicitly recommends trying the DOM before batchPlay, but batchPlay remains the practical fallback for many Photoshop commands. 

javascript
Copy
const { action, core } = require("photoshop");

async function applyGaussianBlur(radiusPx = 12) {
  await core.executeAsModal(
    async () => {
      await action.batchPlay(
        [
          {
            _obj: "gaussianBlur",
            _target: [
              {
                _ref: "layer",
                _enum: "ordinal",
                _value: "targetEnum"
              }
            ],
            radius: {
              _unit: "pixelsUnit",
              _value: radiusPx
            }
          }
        ],
        {}
      );
    },
    { commandName: "Apply Gaussian Blur" }
  );
}
Read and write XMP metadata
The XMP module is now the cleanest official way to work with embedded metadata. The snippet below assumes a PSD or PSB file that the user has explicitly selected, then reads and updates xmp:CreatorTool. Because this is file-level XMP, use an explicit file Entry; do not assume the currently active document has a meaningful native path. 

javascript
Copy
const { storage, xmp } = require("uxp");

async function readWriteCreatorTool() {
  const fs = storage.localFileSystem;
  const entry = await fs.getFileForOpening({ types: ["psd", "psb"] });

  if (!entry) {
    return null;
  }

  const nativePath = fs.getNativePath(entry);
  const { XMPFile, XMPMeta, XMPConst } = xmp;

  const xmpFile = new XMPFile(
    nativePath,
    XMPConst.FILE_PHOTOSHOP,
    XMPConst.OPEN_FOR_UPDATE
  );

  const meta = xmpFile.getXMP() || new XMPMeta();
  const existing = meta.getProperty(XMPConst.NS_XMP, "CreatorTool");

  meta.setProperty(XMPConst.NS_XMP, "CreatorTool", "My Plugin");
  xmpFile.putXMP(meta);
  xmpFile.closeFile(XMPConst.CLOSE_UPDATE_SAFELY);

  return {
    before: existing ? existing.value : null,
    after: "My Plugin"
  };
}
Export the active document
For standard export workflows, the DOM saveAs API is often enough and is considerably easier to maintain than export descriptors. Use an explicit save destination from localFileSystem, and wrap export in executeAsModal so the operation behaves consistently with other write actions. 

javascript
Copy
const { app, core } = require("photoshop");
const { storage } = require("uxp");

async function exportActiveAsJpeg() {
  const doc = app.activeDocument;
  if (!doc) {
    throw new Error("No active document.");
  }

  const suggestedName = `${doc.title.replace(/\.[^.]+$/, "")}.jpg`;
  const fs = storage.localFileSystem;

  const entry = await fs.getFileForSaving(suggestedName, {
    types: ["jpg"]
  });

  if (!entry) {
    return null;
  }

  await core.executeAsModal(
    async () => {
      await doc.saveAs.jpg(
        entry,
        {
          quality: 10,
          embedColorProfile: true
        },
        true
      );
    },
    { commandName: "Export JPEG" }
  );

  return entry;
}
Persist a user-selected folder across sessions
Many real plugins need a “working folder” or “export folder”. Persistent tokens are the documented way to do that, but they can fail later, so the right pattern is “try the stored token, then recover by prompting again.” 

javascript
Copy
const { storage } = require("uxp");

async function getRememberedFolder() {
  const fs = storage.localFileSystem;
  const key = "working-folder-token";
  const cachedToken = localStorage.getItem(key);

  if (cachedToken) {
    try {
      return await fs.getEntryForPersistentToken(cachedToken);
    } catch (err) {
      // token is stale; fall through and re-prompt
    }
  }

  const folder = await fs.getFolder();
  if (!folder) {
    return null;
  }

  const token = await fs.createPersistentToken(folder);
  localStorage.setItem(key, token);
  return folder;
}
Tooling, Testing, and Debugging
The official development workflow is centered on the UXP Developer Tool. UDT creates starter projects, loads plugins into Photoshop, watches files for changes, reloads code, opens a Chrome-like debugger, exposes logs, and packages finished plugins. It also requires elevated privileges and Developer Mode to load development plugins. For Hybrid plugins, Adobe’s docs split debugging in two: JavaScript in UDT, native code by attaching your IDE to the Photoshop process. 

There is no strong reason to invent a custom build story before you need one. If your plugin is simple, a no-build vanilla setup is fine. If the UI is complex, the official samples now cover React, Vue, Svelte, SWC starters, Tailwind, TypeScript plus Webpack, WebAssembly via Rust, OAuth workflows, helper-app communication, secure storage, and web-service calls. That sample breadth is one of the clearest signs of Adobe’s current recommended ecosystem. 

Testing and debugging checklist
Test the real support floor, not just the latest Photoshop. If you claim 23.3+, run on that floor; if you claim 24.4+ for SWC, test on that floor too; if Hybrid, test Mac Intel, Apple Silicon, and Windows Intel explicitly. 
Exercise cancel paths and denied-permission paths. File pickers can be canceled, launchProcess triggers consent, and fullAccess changes install/update behavior. 
Test with no document, one document, and multiple documents. Much plugin code fails not on core logic but on absent or changed target context. Photoshop’s APIs are asynchronous and document-scoped, so defensive checks matter. 
Test local documents and cloud documents separately. Document.path is not always a local filesystem path. 
Validate your panel in all host themes. Photoshop explicitly supports multiple interface themes, and Spectrum components are designed to help with theme compatibility. 
If you expose commands, verify Actions integration. Test enableMenuRecording and recordAction early instead of treating them as release polish. 
Use UDT Watch for code, but remember Reload does not reload the manifest. Manifest changes often require a full unload/load cycle. 
Use the debugger with source maps if bundling. Adobe’s plugin workflow docs explicitly call out source-map support. 
Generate batchPlay from Photoshop whenever possible. Adobe’s changelog documents “Copy as JavaScript” from the Actions panel as a batchPlay helper; it is faster and safer than hand-authoring everything from memory. 
Use app.eventNotifier only in development to discover events, then replace it with explicit listeners. Adobe documents the catch-all notifier as development-only. 
For obscure batchPlay work, use community listener tools cautiously. Davide Barranca’s BatchPlay tutorials and the Alchemist-listener workflow are still some of the most practical supplements to the official docs. 
For Hybrid plugins, debug JS and C++ separately. UDT handles the JS side; your IDE should attach to Photoshop.exe or the macOS equivalent for native breakpoints. 
Security, Performance, and Distribution
Security best practices
Start with least privilege. Manifest v5’s permissions model makes this easier, but it also makes overreach more visible. Restrict network access to only the domains you need, prefer localFileSystem: "request" over fullAccess, and scope launchProcess to the smallest viable set of URI schemes and file extensions. fullAccess changes installer consent, and openExternal/openPath still prompt at runtime. 

Use secureStorage for tokens or other locally protected values, but do not treat it as a perfect secret vault. Adobe is explicit that it is protected under the current user account, that keys are not encrypted, and that contents can be lost; the same docs tell you not to put passwords into localStorage. In practice, regard secure storage as a recoverable cache, not as your source of truth. 

Treat WebViews as a special-case tool, not as your default UI substrate. They require explicit permission, are currently dialog-only in Photoshop, and Adobe warns that domains: "all" is not recommended for security, privacy, and enterprise-compatibility reasons. If you only need OAuth or help content, compare WebView against launchProcess plus the system browser or a small external helper flow. 

Performance best practices
Prefer the DOM when possible, and reach for batchPlay only for coverage gaps. That is Adobe’s own recommendation, and it aligns with maintainability: DOM code is more legible, easier to type-check, and easier to regression-test. When you do use batchPlay, keep descriptors in a dedicated module rather than mixing them into UI event handlers. 

Use executeAsModal consistently for write operations, and group related mutations into a single history state where appropriate. Photoshop’s modal model is about correctness as much as UX: only one plugin gets the modal scope at a time, and history suspension can prevent a single user action from generating a messy history trail. Also remember that users can cancel modal operations, so long-running loops must check cancellation. 

Do not load on startup unless the product truly needs it. Adobe’s manifest docs say plugins are lazy-loaded by default to reduce CPU and memory impact, and reserve startup for cases like listeners or remote-process communication. Similarly, entrypoint lifecycle hooks in Manifest v5 have a 300 ms timeout, which is a strong hint that heavyweight initialization belongs behind lazy service calls, not in create() or show(). 

If your bottleneck is pixel access rather than host-command orchestration, consider the Imaging API or native acceleration. The Imaging API gives direct pixel access from JavaScript but is still explicitly labeled beta in the Photoshop changelog. Hybrid plugins are the better choice when you need OpenCV-class processing, existing native pipelines, or lower-latency compute. If you need a true Photoshop-native filter or file-type plugin, leave UXP orchestration and use the C++ SDK. 

Signing and distribution through the marketplace
For UXP plugins, packaging is .ccx, and the Photoshop packaging docs tell you to obtain a valid plugin ID from the marketplace portal before packaging for distribution. Local testing is straightforward: package with UDT, double-click the resulting .ccx, install it through Creative Cloud Desktop, and test again as an installed artifact before submitting publicly. Public distribution goes through review in the modern portal, which replaced older UXP and ZXP management surfaces. Adobe’s current submission docs also require a publisher profile, and EU visibility depends on trader details being present. 

UXP distribution is materially simpler than CEP distribution. Adobe’s cross-product UXP packaging docs note that .ccx packages do not require the old developer-applied digital signature and timestamp that .zxp packages needed. CEP packages still rely on ZXPSignCmd and certificate handling. Hybrid UXP plugins are the exception to “simple”: the package is still UXP-based, but macOS executables must be signed and notarized, and end users will be asked for OS admin credentials during install and update because native code is involved. 

Build and Publish Checklist
Choose the real compatibility floor up front. Use 23.3+ if you want Manifest v5; 24.4+ if you want SWC with the documented manifest path; 24.2+ if Hybrid is in scope. 
Create the project in UDT and enable Developer Mode. UDT is the official create/load/debug/package workflow, and Developer Mode is required for loading development plugins. 
Start with one panel and one command. That gives you both a persistent UI surface and a headless automation surface without overcommitting your IA. 
Use Manifest v5 with narrow permissions. Add network, localFileSystem, clipboard, launchProcess, or webview only after the product genuinely needs them. 
Implement a service layer for host access. Keep DOM calls, batchPlay descriptors, and event notifiers out of UI components. This is not an Adobe requirement; it is the most reliable way to keep a plugin maintainable as host coverage evolves. Supported by the split between DOM, batchPlay, and events in the official API. 
Default to DOM, then add batchPlay only for gaps. Use “Copy as JavaScript” from the Actions panel to author descriptors faster. 
Use explicit Entry objects and persistent tokens for files. Do not build the product around inferred OS paths from active documents. 
Make the UI Spectrum-based and theme-aware. Panels should behave like first-class Photoshop surfaces, not like transplanted browser pages. 
Set up your build only as far as necessary. Vanilla JS is enough for simple plugins; official samples exist for React, Vue, Svelte, TypeScript/Webpack, Tailwind, WASM, OAuth, helper apps, and secure storage. 
Test on the packaged artifact, not just the loaded dev plugin. UDT packages .ccx; install it locally and run a full regression pass before review. 
Create the publisher profile and review materials in the marketplace portal. Expect screenshots, icons, support metadata, and trader details if you want EU availability. Public distribution requires review. 
Use the right signing path for your extension type. UXP .ccx is simpler than CEP .zxp; CEP still needs ZXPSignCmd, and Hybrid adds native-signing requirements on macOS. 
Prioritized sources
The most useful official and near-official sources for implementation are the following, in roughly the order I would use them during design and delivery:

Photoshop APIs for developers and scripters — the best top-level map of UXP Plugins, Hybrid, CEP, ExtendScript, and C++ positioning. 
Manifest v5 — the permissions model, WebView rules, lifecycle details, and modern manifest shape. 
Photoshop-specific manifest properties — apiVersion, loadEvent, and enableMenuRecording. 
Photoshop API reference and batchPlay docs — the host API surface and the advanced descriptor layer. 
UXP Developer Tool docs and plugin workflows — the canonical dev/debug/package workflow. 
Designing for Photoshop — the best official guidance on panel vs dialog UX. 
Spectrum UXP reference and SWC docs — component strategy, framework compatibility, and SWC migration direction. 
uxp-photoshop-plugin-samples on GitHub — the highest-value implementation repo, especially for React, Vue, Svelte, TypeScript/Webpack, Tailwind, secure storage, helper apps, OAuth, and WASM patterns. 
Hybrid plugin docs and CSDK bridge docs — the right path when performance or native integration becomes real. 
Developer Distribution and submission docs — review requirements, publisher profile, and current marketplace workflow. This is the practical replacement context for older “Exchange partner portal” assumptions. 
Community deep dives by Davide Barranca — especially BatchPlay and Manifest v5 edge cases, useful after you understand the official model. 
Minifloppy’s 2023 UXP articles — concise, recent community walkthroughs that complement the official docs without trying to replace them. 
The short version is this: if you are designing a plugin from scratch today, treat UXP as the product surface, Manifest v5 as the default contract, UDT as the default toolchain, DOM-first host calls as the default coding style, batchPlay as the fallback, and Hybrid/C++ as a deliberately justified escalation rather than the starting point. 