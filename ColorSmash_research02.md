# Designing a Sophisticated Photoshop Color Match Plugin: Algorithms, Reverse-Engineering, and Procedural Emulation

## 1. Executive Summary

Adobe has never published the exact algorithm used by Photoshop’s Match Color command, so any technical model is necessarily approximate, but there is strong evidence that it performs global color transfer based on channel statistics in an RGB-like space with options for luminance scaling, saturation scaling, global fade, and an additional cast-neutralization term. Academic and practitioner sources explicitly state that Photoshop Match Color is based on standard color transfer techniques similar to Reinhard’s mean/variance matching, which aligns channel means and standard deviations between source and target. Its behavior, limitations, and the semantics of its controls are consistent with global mean/std matching and optional cast removal rather than full histogram matching or high-order palette mapping.[^1][^2][^3][^4][^5][^6][^7][^8][^9][^10]

For a modern replacement plugin, the best technical core is a multi-stage color-transfer architecture that combines global mean/variance matching in a decorrelated color space (e.g., Lab or opponent space), optional higher-order or optimal-transport based distribution matching (e.g., sliced optimal transport), and spatial/semantic weighting for important regions such as faces and neutral surfaces. This core can be exposed either as a direct pixel transform (fast and precise), a generated 3D LUT (portable and Photoshop-native), or a hybrid workflow in which the plugin both applies a transform and emits a LUT plus helper adjustment layers for tonality, gamut compression, and protect-skin/protect-neutrals controls.[^2][^11][^12][^13][^14][^15][^6][^16][^17]

Photoshop-native tools can emulate a large fraction of Match Color’s behavior by stacking Curves/Levels for tonal normalization, Hue/Saturation or Vibrance for chroma scaling, Color Balance/Selective Color for hue/cast shaping, Gradient Map for palette remapping, and Blend If or luminosity masks for tonal zoning, all driven by statistics extracted from source and target. However, these tools are mostly 1D per-channel or 1D-per-luminance remaps and cannot represent general 3D color transforms that alter channel correlation structure or perform complex palette warps without resorting to Color Lookup (3D LUT) or direct pixel processing.[^11][^18][^13][^19][^20]

3D LUTs are the most practical non-destructive representation for complex color-matching transforms in Photoshop: they can encode arbitrary 3D mappings from RGB to RGB, are efficiently evaluated on GPU, and integrate directly via Color Lookup adjustment layers, but they are not easily editable in terms of intuitive sliders once baked. A robust plugin should therefore compute a primary 3D LUT for color style transfer, optionally pre- and post-condition it with simple tonal curves, and then add editable helper layers (Curves, Levels, Vibrance, protective masks) to give artists fine-tuning controls that map back to intuitive parameters such as match amount, luminance strength, chroma strength, preserve neutrals, preserve skin, and protect highlights.[^13][^14][^19][^15][^16][^20][^11]

The recommended architecture is a UXP-based Photoshop plugin that (1) analyzes source/target statistics and key regions (faces, neutrals), (2) computes a parametric global color-transfer mapping with optional OT-based refinement, (3) outputs a 3D LUT plus an accompanying procedural layer stack tuned to the user’s controls, and (4) optionally operates as a Smart Filter on Smart Objects for fully non-destructive workflows. The first prototype should implement Reinhard-style Lab mean/std matching with simple contrast and saturation controls; the medium-term version should add OT-based distribution matching, face/skin-aware weighting, and LUT export; the advanced version should integrate semantic segmentation, local transfers, and learned models (e.g., flow-based OT or ML presets) for complex composites.[^3][^21][^6][^22][^17][^2][^11][^13]

## 2. Evidence Review

### 2.1 Adobe official documentation

Adobe’s Match Color documentation states that the command works only in RGB mode and allows users to “make the colors of one image consistent with another” via controls for Luminance, Color Intensity, Fade, and a Neutralize checkbox to remove color casts. The docs describe the command as using image statistics between a source and destination image or layer and make clear that Neutralize removes an overall color cast from the target. Reliability is high for the existence and semantics of controls but low for detailed algorithmic behavior, as Adobe does not publish formulas or reference implementation details.[^7][^10][^1]

Adobe’s Color Lookup adjustment documentation confirms that Photoshop’s LUT workflow is based on loading 3D LUT files as presets, remapping image colors according to the table, and then optionally modulating the effect via blend modes and opacity. This establishes that arbitrary 3D color transforms can be hosted non-destructively as adjustment layers, and Color Lookup is the natural vehicle for any plugin that exports LUTs.[^11][^13]

### 2.2 Academic and technical references on Match Color

A SIGGRAPH paper on realism of image composites explicitly states that Photoshop Match Color uses a standard color transfer technique that aligns the means and variances of the color histograms of two regions, citing Reinhard et al.’s color transfer method. A recent study on facial color normalization notes that histogram matching is “used in Photoshop (Match Color)” when describing strict distribution adjustment between images, treating Photoshop’s tool as an implementation of histogram-specification style methods for faces. These sources are highly credible academically and directly link Match Color to mean/variance matching and histogram matching paradigms, though they may be inferring based on behavior rather than proprietary code.[^8][^9][^2][^3]

A Photoshop education PDF for Match Color describes Luminance as adjusting brightness, Color Intensity as saturation, and Fade as reducing the strength of the adjustment, with Luminance and Color Intensity having a range of 1–200 and Color Intensity values near 1 producing a grayscale result. Practitioner articles emphasize Neutralize as a way to remove strong color casts (such as underwater blue/green casts), indicating that Neutralize likely applies a white-balance-like chromatic adaptation that re-centers average chroma near neutral.[^4][^5]

### 2.3 Color transfer and optimal transport literature

Reinhard et al.’s classic color transfer paper proposes converting images to a decorrelated opponent space (e.g., Lab or a variant Lαβ), then shifting and scaling each channel of the target so that its mean and standard deviation match those of the source: 

\[ I'_t = \sigma_s/\sigma_t (I_t - \mu_t) + \mu_s, \]

performed independently per channel. This method uses only first- and second-order statistics, is computationally cheap, and is widely adopted in both research and practice for global color style transfer.[^6][^2][^3]

More advanced methods treat color transfer as a distribution-matching or optimal transport (OT) problem, mapping the full color histogram of the target to that of the source with cost functions like Wasserstein distance. Sliced optimal transport and related approaches project high-dimensional color distributions onto multiple 1D lines, perform 1D OT along each projection, and aggregate the transforms, enabling efficient approximations of full OT for large images. Recent work on rectified flows and Modulated Flows performs color transfer via invertible neural flows that approximate OT plans in RGB space and can generalize to new image pairs.[^23][^12][^21][^22][^17]

A survey/tutorial on color transfer highlights three main families of methods: (1) global linear statistics (mean/std in various color spaces), (2) histogram matching/specification (global or per-channel), and (3) spatially or semantically local transfer, including segmented or palette-based approaches. This survey is particularly useful in classifying which methods can be implemented as 1D curves, 3D LUTs, or require custom transforms.[^6]

### 2.4 Human perception, color spaces, and color difference

Perceptual color difference metrics such as CIEDE2000 (ΔE00) are defined over CIELAB color space and aim to correlate Euclidean distance with perceived difference, with corrections for blue hues and interactions between chroma and hue. Uniform color spaces and natural image statistics research shows that projecting natural images into CIELAB yields more uniform distributions and that blue-yellow opponency is a dominant axis, informing the choice of Lab-like spaces for color transfer aimed at perceptual plausibility.[^24][^25][^26][^27]

Studies on human color detection and classification in natural scenes indicate that both luminance contrast and saturation contrast contribute roughly additively to detectability of stimuli, implying that both tone and chroma distributions matter for perceived matching. Memory-color research for faces and color-diagnostic objects shows that observers have strong expectations for skin tones and canonical object colors; deviations in these regions can be more salient than deviations in background hues. In applied imaging domains such as dentistry, matching L*, a*, b* values of teeth to standardized guides demonstrates that L* (lightness) often has the largest impact on perceived attractiveness and matching quality, highlighting the primacy of luminance distribution and black/white points.[^28][^29][^30][^31]

### 2.5 Practitioner and workflow references

Practitioner articles on Photoshop color adjustments emphasize that Curves provides the ultimate control over luminance and per-channel hue via arbitrary 1D curves, Hue/Saturation and Vibrance control saturation and hue but lack direct tonal separation, and Selective Color and Photo Filter offer more localized color adjustments in specific ranges. Tutorials on Blend If explain that it is effectively a luminance- or channel-value-based masking mechanism that enables tonally selective blending in a single layer, functionally similar to luminosity masks but parameterized as thresholds and split sliders.[^18][^19][^20]

Guides to Color Lookup adjustment layers emphasize that 3D LUTs map existing colors to new ones according to a cube grid and are ideal for applying complex creative looks, but they are opaque and require precomputed LUT files. Articles on LUTs vs color profiles clarify that LUTs implement arbitrary color grading transforms between color spaces or looks, while ICC profiles characterize devices and ensure color consistency, reinforcing LUTs as the right tool for creative color transfer within Photoshop.[^15][^16][^13][^11]

A blog post from a fine-art photographer describes Match Color as useful for exact matching between product shots, for removing strong color casts (e.g., underwater images) via Neutralize, and for creative cross-image grading, again consistent with a global statistical transfer with optional neutralization. Tutorials and videos demonstrate that Luminance adjusts brightness of the applied effect, Color Intensity behaves like saturation of the transferred color, Fade globally blends effect vs original, and Neutralize removes overall casts.[^32][^33][^34][^10][^4]

### 2.6 Reliability assessment

- Adobe documentation: Highly reliable for user-visible behavior (controls, limitations like RGB-only) but silent on implementation details.[^1][^7]
- Academic papers (Reinhard, color transfer surveys, OT methods, realism of composites): Highly reliable for algorithm descriptions and for statements about similarity between Match Color and mean/std matching; moderate for exact claims about proprietary Adobe implementation.[^2][^3][^8][^6]
- Human perception and color difference literature: Highly reliable for which statistics matter perceptually; indirect but valuable for plugin design goals.[^25][^26][^30][^31]
- Practitioner tutorials and blogs: Medium reliability; useful for behavioral characterization of Match Color and Photoshop adjustments, less so for exact math.[^5][^19][^20][^10][^4]
- Patents (Adobe skin tone assisted color matching): Highly reliable for describing specific new systems; not explicitly linked to Match Color but relevant for future skin-preserving controls.[^14]

## 3. Candidate Models of Photoshop Match Color

Because Adobe has not released the Match Color algorithm, the following models are inferential, guided by academic references explicitly linking Match Color to known techniques and by observed behavior.

### 3.1 Model 1: Global per-channel mean/std matching in RGB or opponent space + tone/chroma scaling + neutralization

**Core idea.**

- Convert source and target to an internal RGB or opponent color space (possibly device-independent but constrained to RGB mode, consistent with documentation).[^7][^1]
- For each of three channels, compute mean and standard deviation over the selected region (or entire image) for source and target.
- Apply per-channel affine transform to target pixels to match source mean and variance, optionally blended according to Luminance and Color Intensity settings.
- Apply Neutralize as a chromatic adaptation that shifts overall mean chroma toward gray in some opponent space.
- Apply Fade as a convex blend between transformed and original target.

**Fit to evidence.**

- A SIGGRAPH compositing paper states directly that Photoshop’s Match Color uses a standard color transfer technique that aligns means and variances of color histograms, citing Reinhard’s method.[^3][^8][^2]
- Reinhard’s method is exactly global mean/std matching per channel in an opponent space, typically Lab or Lαβ.[^2][^6]
- This method is computationally cheap, robust, and consistent with Match Color’s responsiveness and availability even on modest hardware.[^8]
- The presence of Luminance and Color Intensity sliders suggests scalar gains applied to the luminance and chroma components of the transfer, while Fade is naturally modeled as linear interpolation between original and transformed pixels.[^34][^10][^5]
- Neutralize’s effect in practice (removing strong casts while preserving local color relationships) is compatible with subtracting or scaling a global chroma mean or performing a gray-world style chromatic adaptation.[^4][^3]

**What remains uncertain.**

- Exact working color space: documentation says Match Color works only in RGB mode, but internal computations might use an intermediate decorrelated space like Lab even if input must be RGB. Academic references mention Reinhard-style methods in opponent spaces but do not confirm Adobe’s choice.[^1][^3][^7][^8][^2]
- Exact application of Luminance and Color Intensity: they may scale the mean and variance shifts, or only the variance term, or apply an additional gamma-like curve before/after transfer.[^5]
- Neutralize details: whether it performs simple gray-world (shifting channel means to equal), Von Kries adaptation in XYZ/LMS, or a more complex adaptation is unknown.[^35][^36][^14]

**Behavioral manifestations.**

- Works best when source and target have roughly similar content and exposure; can produce unnatural results if histograms are very different, consistent with mean/std limitations.[^10][^4]
- Tends to preserve overall contrast structure but alters color balance and saturation; extreme differences can cause clipping or oversaturation artifacts.[^8]
- Neutralize quickly removes strong global casts but may over-flatten creative grading if overused.[^4]

### 3.2 Model 2: Per-channel histogram matching/specification in RGB with controls as post-operators

**Core idea.**

- Treat each RGB channel as a 1D histogram and compute its cumulative distribution function (CDF) for source and target regions.
- Construct a mapping per channel such that target CDF is mapped to source CDF (classic histogram specification).[^37][^6]
- Apply Luminance, Color Intensity, and Fade as brightness/saturation/global blend controls layered over the histogram mapping.
- Neutralize may be implemented as a global gray-world adjustment either before or after histogram matching.

**Fit to evidence.**

- Some technical and applied papers state that histogram matching is used in Photoshop Match Color, particularly in facial normalization and other global normalization tasks.[^9]
- Histogram matching is standard in image processing and could plausibly be Adobe’s chosen method, given its widespread use for matching tonal distributions.[^37][^6]

**What remains uncertain / conflicts.**

- The SIGGRAPH compositing paper explicitly distinguishes mean/variance color transfer (Reinhard-like) and histogram-based methods, and attributes Match Color to the former. This suggests that pure per-channel histogram matching is less likely as the primary mechanism.[^6][^8]
- Per-channel histogram matching in RGB can create severe artifacts, especially when channel correlations differ between images, whereas Match Color is relatively robust in typical use cases.[^6][^8]
- There are no Adobe statements confirming histogram matching; references are indirect.

**Behavioral manifestations.**

- Very strong enforcement of cumulative distributions; may over-fit source histogram, causing banding or flattening in tonal areas and distortions in colors when source/target content differ significantly.[^9][^37]
- Limited ability to respect cross-channel correlation; can distort neutral axis and introduce unexpected hue shifts.[^6]

### 3.3 Model 3: Hybrid statistics: mean/std in opponent space + limited histogram or palette adjustments

**Core idea.**

- Perform primary transfer as global mean/std matching in an opponent space (like Model 1).[^2][^8][^6]
- Optionally refine via limited histogram or palette corrections—e.g., piecewise linear remapping of luminance histogram to better match source, or cluster-based adjustment of dominant colors.
- Neutralize might be implemented in opponent space in coordination with the global transfer, preserving some highlights and skin tone constraints.

**Fit to evidence.**

- This model reconciles the SIGGRAPH statement about mean/std alignment with applied literature that mentions histogram matching in Photoshop.[^9][^8]
- It explains Match Color’s generally smooth behavior while allowing for better adaptation to different tonal distributions than pure mean/std.
- It fits the fact that Match Color can sometimes handle more complex scenes than simple Reinhard transfer without severe artifacts, suggesting some additional heuristics.[^10][^4]

**What remains uncertain.**

- There is no direct evidence of hybrid palette or cluster-based refinement in Match Color; this is conjectural.
- Implementation complexity vs. age of the tool: Match Color predates many advanced OT and palette methods; a hybrid mean/std + simple histogram tweak is plausible but unconfirmed.[^8][^6]

**Behavioral manifestations.**

- Better adaptation when source and target histograms differ in shape (e.g., high-key vs low-key) than pure mean/std, while avoiding abrupt artifacts of full histogram specification.[^8][^6]
- Some non-linearities in shadows/highlights that users perceive as better tonal matching than a simple global affine transform.

### 3.4 Uncertainty summary

The weight of evidence favors Model 1 (Reinhard-style mean/std alignment) as the primary mechanism behind Match Color, with Models 2 and 3 representing less likely or partial explanations based on applied references. No source confirms exact equations, and implementation details like working color space, clipping behavior, and interaction between controls remain speculative.[^3][^9][^2][^6][^8]

## 4. Algorithm Comparison

### 4.1 Core methods

Below, “direct transform” means a pixel-wise mapping; “curves/stack” means representation as Photoshop adjustment layers; “3D LUT” means representation as a cube.

#### Key methods and characteristics

1. **RGB mean/variance matching (per-channel affine in RGB).**
   - Core idea: Compute µ and σ per RGB channel for source and target; apply \(I' = \sigma_s/\sigma_t (I_t - \mu_t) + \mu_s\) per channel.[^6]
   - Stats: Uses first and second moments per channel; ignores cross-channel covariance.
   - Strengths: Extremely fast; easy to implement; can be expressed as per-channel 1D curves.[^6]
   - Weaknesses: Can distort neutrals and hue relationships when channel correlations differ; prone to oversaturation and clipping with very different histograms.[^8][^6]

2. **Reinhard-style transfer in Lab/Lαβ.**
   - Core idea: Convert to decorrelated opponent space (Lab or Lαβ); match µ and σ of each channel.[^3][^2][^6]
   - Stats: First and second moments in a perceptual or opponent space; cross-channel correlation reduced, so transfer is more perceptually meaningful.
   - Strengths: Better perceptual plausibility; supports global style transfer with relatively few artifacts; inexpensive.[^2][^6]
   - Weaknesses: Still global; cannot match multimodal palettes or complex scene differences; may over- or under-correct local regions; needs careful handling of gamut mapping back to RGB.[^6]

3. **Per-channel histogram matching in RGB.**
   - Core idea: Use CDFs to map each channel’s histogram to match the source.[^37][^6]
   - Stats: Full 1D distribution per channel.
   - Strengths: Exact histogram equality per channel; good for tonal normalization when channel independence is acceptable.[^37]
   - Weaknesses: Ignores cross-channel correlation, potentially distorting hue and neutrals; prone to artifacts when source/target content differ in composition.[^9][^6]

4. **Histogram matching in Lab or luminance + chroma.**
   - Core idea: Match luminance histogram separately from chroma histogram (possibly per-chroma channel), or apply histogram matching only to L* while using simpler statistics for a*, b*.[^6]
   - Stats: Full distribution for tone; partial for chroma.
   - Strengths: Better control over luminance distribution while preserving color relationships; fits human sensitivity to lightness differences.[^26][^25]
   - Weaknesses: More complex to map back to RGB without artifacts; global operation still ignores spatial structure.

5. **Sliced / projected optimal transport.**
   - Core idea: Approximate OT between color distributions via random projections to 1D, performing 1D OT in each projection and aggregating; yields a 3D transform approximating Wasserstein transport.[^12][^17][^23]
   - Stats: Full joint distribution in RGB or opponent space, approximated via projections.
   - Strengths: Can match complex palette differences and multimodal distributions; yields smooth global transforms that respect cross-channel structure; still relatively efficient.[^17][^12]
   - Weaknesses: More computationally expensive than mean/std; non-trivial to implement robustly as a plugin; may need regularization to avoid overfitting.[^17]

6. **Palette / cluster-based transfer.**
   - Core idea: Cluster source and target colors (e.g., k-means in Lab), match clusters, and transfer cluster centers or define local transforms per cluster.[^6]
   - Stats: Cluster centroids and assignment; approximates distribution structure with a small palette.
   - Strengths: Intuitive for artistic control; can preserve semantic regions if clusters align; efficient for large images.[^6]
   - Weaknesses: Sensitive to clustering choices; may create discontinuities at cluster boundaries; less suitable for automatic, parameter-free workflows.

7. **Local / spatially varying transfer (e.g., segmented, face-aware).**
   - Core idea: Segment image into semantic or tonal regions (e.g., faces, sky, foreground), apply separate transfer per region, and blend at boundaries.[^14][^6]
   - Stats: Regional statistics (µ, σ, histograms) plus masks.
   - Strengths: Addresses key limitation of global transfer by preserving skin tones and local context; ideal for composites and portraits.[^31][^14]
   - Weaknesses: Requires segmentation (which may be ML-based); more complex to expose as a simple plugin; risk of haloing if blending is not well designed.[^6]

8. **ML-based approaches (e.g., Deep Preset, flows, cmKAN).**
   - Core idea: Train neural networks to learn mappings between source and target color styles given example pairs; can operate directly in RGB or raw domains.[^38][^21][^22]
   - Stats: Implicitly capture complex joint distributions and semantic context.
   - Strengths: Can learn nuanced, context-aware transfers; supports one-click styles; some methods (flows) are invertible and can be approximated by LUTs.[^22][^38]
   - Weaknesses: Requires dataset and training; risk of hallucination or instability on out-of-distribution inputs; harder to explain or expose as explicit sliders.

9. **Color appearance model based transfer.**
   - Core idea: Use color appearance models (e.g., CIECAM02) to account for viewing conditions and human perception, matching appearance rather than raw Lab or RGB values.[^39][^26]
   - Stats: Transform to appearance space, then apply transfer (e.g., mean/std or OT) there.
   - Strengths: More accurate under changing illumination and surround conditions; may better preserve perceived contrast and colorfulness.[^26]
   - Weaknesses: Complex to implement; performance cost may be high; benefits over Lab-based pipelines may be marginal for many photographic cases.[^40][^39]

### 4.2 Comparison table

| Method | Accuracy / Fidelity Potential | Editability | Computational Cost | Robustness | Fit for Photoshop Workflow | LUT / Stack / Direct Transform |
|--------|-------------------------------|------------|--------------------|-----------|----------------------------|--------------------------------|
| RGB mean/std | Moderate; global, can distort neutrals[^6][^8] | High via per-channel Curves | Very low | Good for similar scenes, weak for very different histograms[^6] | Easy as script or plugin; matches legacy Match Color behavior | Curves stack or 3D LUT or direct |
| Lab mean/std (Reinhard) | Higher; perceptually better globals[^2][^6] | High; curves in Lab-like space then converted | Low | Good for many styles; still global-only[^6] | Excellent; core of many color tools | 3D LUT (preferred), direct; stack via Curves + Lookup |
| RGB hist matching | High per-channel histogram fidelity, low perceptual fidelity[^37][^9] | Medium; complex curves per channel | Medium | Sensitive to content differences; can artifact[^6] | Reasonable for niche tasks; not artist-friendly | Curves (1D) or LUT or direct |
| Lab hist / L* hist | High tonal fidelity; better perceptual match[^6] | Medium | Medium | Robust for luminance, modest for chroma | Good for tonal normalization plugins | LUT or curves for L* + 3D LUT |
| Sliced OT | Very high; matches full distribution[^17][^12] | Low-medium; parameters (strength, regularization) not intuitive | Higher but practical with optimization | Robust to complex palette differences; requires safeguards | Excellent for advanced plugin backend | 3D LUT or direct transform |
| Palette / cluster | Moderate-high; captures main colors[^6] | High; artist can edit palette | Medium | Robust if clusters stable; may halo | Good for stylized plugins, color grading | LUT or procedural stack with Gradient Map, Selective Color |
| Local / segmented | Very high for important regions[^14][^31] | Medium; masks editable | Medium-high | Robust if segmentation good; risk at boundaries | Ideal for portrait/composite tools | Combine LUTs + masks + stacks |
| ML (Deep Preset, flows) | Very high on-domain[^38][^22][^21] | Low-medium; mostly preset-based | High (training), moderate at inference | Sensitive to training data; may fail OOD | Good for preset/style products | Direct transform; may approximate as LUT |
| Appearance-model transfer | High perceptual fidelity under varying viewing[^26][^39] | Medium | High | Robust in controlled workflows | Niche but strong for print/preview pipelines | LUT (complex) or direct |

For a production-grade Photoshop plugin, Lab mean/std plus optional sliced OT or palette-based refinement offers the best balance between fidelity, performance, and implementability, with 3D LUTs used as the main representation for non-destructive integration.[^16][^17][^2][^6]

## 5. Photoshop Procedural Emulation Strategies

This section focuses on constructing layer stacks that approximate Match Color or more advanced color-transfer behavior using only native tools.

### 5.1 Capabilities and limits of key tools

- **Curves.** Arbitrary 1D remaps per channel, allowing control of luminance, per-channel tone curves, and basic color balance; cannot model cross-channel coupling beyond channel-specific curves.[^19][^20]
- **Levels.** 1D linear remap with black/white point and gamma per channel; good for quick normalization of tonal range and basic color balancing.[^20]
- **Hue/Saturation, Vibrance.** Adjust global or range-limited hue and saturation; Vibrance boosts low-saturation colors more and protects skin tones somewhat.[^19]
- **Color Balance, Selective Color.** Provide region-limited (shadows/mids/highlights or color families) additive/subtractive adjustments; effectively piecewise linear 3D-ish transforms with coarse segmentation.[^19]
- **Gradient Map.** Maps luminance (or another channel via blending) to a gradient of colors; effectively a 1D luminance-indexed 3D transform.[^19]
- **Channel Mixer.** Linear combination of input channels into outputs; full 3×3 linear transform in RGB after normalization.[^19]
- **Color Lookup.** Applies 3D LUTs; full 3D nonlinear transform; best for complex mapping.[^13][^11]
- **Blend If / split sliders.** Component-wise masking based on luminosity or channel values of current and underlying layers; effectively range-based spatial masking with soft transitions.[^18]
- **Masks, luminosity masks, channel masks.** Provide arbitrary spatial masks; combined with above tools, enable local or tonal-region-specific operation.[^18][^19]

These tools can approximate global mean/std matching and simple palette shifts well but cannot perfectly reproduce complex joint distributions without a 3D LUT or custom pixel transform.[^19][^6]

### 5.2 Simple procedural stack: global match approximation

**Goal:** Approximate a Match Color-type global match between source and target using adjustment layers and curves.

**Stack architecture (simplified):**

1. **Base layer:** Target image.
2. **Reference statistics (offline).** Plugin/script (outside Photoshop’s native UI) computes source and target per-channel means and standard deviations in an opponent space (e.g., Lab) and derives L*, a*, b* gain/offset parameters.[^2][^6]
3. **Curves – Luminance match.** One Curves adjustment layer in Luminosity blend mode that approximates the L* mapping from target to source by: 
   - Setting black/white points to match L* min/max.
   - Adjusting midtones via control points to approximate mean shift and contrast scaling.[^20]
4. **Curves – Color channels.** Separate Curves adjustment layers (or a single multi-channel Curves) in Normal or Color blend mode that adjust a and b-like components via channel curves in RGB, approximating mean/std shifts of chroma.[^19]
5. **Hue/Saturation – Chroma scale.** A Hue/Saturation layer that scales Saturation to mimic Color Intensity.[^19]
6. **Neutralization (optional).** A Color Balance layer or Curves in individual channels in Color blend mode that moves neutrals toward gray based on global averages, approximating Neutralize.[^4][^19]
7. **Fade equivalent.** Group all above adjustment layers and lower group opacity or use a Fill slider to emulate Fade.[^10]

**Behavior approximated.**

- Global tone and color statistics aligned with source; user can control overall brightness (via L* Curves), saturation (Hue/Sat), and neutralization (Color Balance/Curves) similar to Match Color controls.[^5][^4][^2]

**Breakdowns / limits.**

- No direct match to Match Color’s internal mathematics; curves are approximations.
- No per-pixel 3D mapping; only per-channel and luminance-indexed mapping.
- Complex cross-channel covariance and palette shapes not captured; tricky to preserve subtle skin tone relationships without additional masking.[^6]

### 5.3 Intermediate stack: tonal zones and protective masks

**Goal:** Add tonal range weighting and protective behavior for skin tones and highlights.

**Stack extensions:**

- **Luminosity masks:** Generate masks for shadows, midtones, and highlights (e.g., using channels or third-party scripts). Use them to restrict the L* Curves and chroma adjustments to specific tonal zones, enabling different match strengths in shadows, mids, and highlights.[^18][^19]
- **Skin mask:** Use color range selection, ML-based skin detection, or hand-painted mask to create a skin-tone region; apply milder chroma/hue adjustments there to “preserve skin” while still matching background.[^31][^14]
- **Highlight protection:** Apply Blend If on key adjustment layers to reduce effect in brightest zones (split sliders for smooth transition), avoiding highlight clipping artifacts.[^18]
- **Gamut compression:** A final Curves or Selective Color layer in Color blend mode that slightly compresses saturated colors toward the center of RGB cube to avoid out-of-gamut mapping when converting back or printing.[^15][^6]

**Behavior approximated.**

- Tonal range weighting similar to advanced color grading tools: stronger match in midtones, lighter in shadows/highlights if desired.
- Protection of skin tones and highlights, which user studies show are perceptually critical for perceived match quality.[^28][^31]

**Breakdowns / limits.**

- Still a composition of 1D or simple 3D operations; cannot express arbitrary 3D transform.
- Complex interdependence between layers makes exact analytically invertible mapping impossible; but for artists the behavior can be intuitive.

### 5.4 Advanced stack: LUT-centric with helper layers

**Goal:** Use a LUT as the main 3D mapping but keep a procedural stack around it for tunability.

**Stack architecture:**

1. **Base layer:** Target image.
2. **Color Lookup (3D LUT).** Main 3D LUT generated by plugin that encodes full color transfer from target to source distribution.[^16][^11][^13]
3. **Curves – Pre-normalization (optional).** A Curves layer below LUT (in normal or Luminosity mode) that pre-normalizes luminance (e.g., to a standard contrast space) before LUT, ensuring LUT is applied to a predictable tonal regime.[^20]
4. **Curves / Levels – Post-toning.** One or two Curves layers after LUT to adjust luminance and contrast according to user controls (luminance match strength, preserve contrast).[^19]
5. **Hue/Saturation or Vibrance – Chroma control.** Post-LUT saturation scaling to implement user’s chroma match strength and saturation rolloff.[^19]
6. **Protective masks.** Luminosity masks and skin masks, as above, modulate LUT layer itself via layer mask or via additional correction layers in Color blend mode for skin/neutral preservation.[^14][^31]
7. **Blend If for tonal gating.** On the LUT and key adjustment layers, use Blend If to limit extreme effects in shadows/highlights, effectively implementing tonal range weighting.[^18]

**Behavior approximated.**

- Near-arbitrary 3D color transform via LUT, similar or superior in fidelity to what Match Color likely does.
- Artist-tunable global parameters: match amount (LUT opacity), luminance/chroma strength (Curves + Saturation), preserve neutrals (neutral masks and Color Balance), preserve skin (skin masks), protect highlights (Blend If).[^11][^13][^19]

**Breakdowns / limits.**

- LUT mapping itself is not editable as curves; plugin must be used to regenerate LUT for any fundamental change.
- Limited to global transform unless multiple LUTs or local application with masks are used.

## 6. LUT vs Layer Stack vs Custom Transform

### 6.1 Conceptual comparison

| Aspect | 3D LUT (Color Lookup) | Adjustment Layer Stack | Direct Pixel Transform (Plugin) |
|--------|-----------------------|-------------------------|---------------------------------|
| Transform class | Full 3D mapping in RGB; arbitrary but fixed[^11][^13][^16] | Composition of mostly 1D and simple 3D operations[^19][^20] | Arbitrary mapping; can implement OT, ML, etc.[^22][^21] |
| Non-destructiveness | Fully non-destructive as adj. layer | Fully non-destructive | Destructive unless wrapped as Smart Filter |
| Editability by artist | Low (mainly opacity, blend mode) | High; every stage editable, intuitive | Low-medium; must surface parameters in UI |
| Computational cost | Very low at runtime; GPU-friendly[^16] | Low-medium; multiple layers, but simple ops | Medium-high; depends on algorithm |
| Export / interchange | LUT can be exported/imported, used in other apps[^15][^16] | Hard to export; Photoshop-specific | Hard to export; must bake to LUT or profile |
| Precision | Grid resolution-dependent; interpolation artifacts at coarse sizes[^16] | High within each adjustment’s precision | High-continuous if implemented in float |
| Representable behavior | Any static 3D mapping, but not spatially varying | Limited to operations expressible as 1D or low-order 3D | Any mapping, including local and semantic |
| Best fit | Capturing complex color style; sharing looks | Giving artists granular control; approximating simpler transfers | Implementing novel algorithms; high-fidelity color transfer |

### 6.2 Tonal normalization before vs after LUT

Many workflows recommend normalizing exposure and contrast before applying creative LUTs so that LUTs see a predictable input space, especially in log or flat footage. For color matching, a hybrid strategy is advisable:[^16]

- **Pre-LUT normalization:** Normalize target luminance (e.g., via Exposure/Curves) so that LUT is applied to a standardized tonal regime; this improves stability of the LUT-based match.[^16][^20]
- **Post-LUT fine-tuning:** Provide post-LUT Curves/Levels to allow users to adjust final contrast and black/white points without invalidating the core match.[^19]

For a plugin that computes its own LUT, normalizing luminance in the statistical model before computing the transform (e.g., mapping target L* to a reference mid-gray/contrast) can reduce the complexity of the LUT and improve perceptual match.[^2][^6]

### 6.3 LUT sufficiency and failure modes

**Sufficient when:**

- The desired mapping is global (same transform applied everywhere) and can be captured as RGB→RGB mapping.
- Complex palette changes, channel correlations, and nonlinear coupling are required.
- Artist editability can be delegated to higher-level parameters (opacity, blend modes, helper layers).

**Fail or limited when:**

- Local, spatially varying transforms are needed (e.g., different mapping for foreground/background, separate treatment for skin and sky).[^14][^6]
- Scene-dependent behavior is required (e.g., dynamic adaptation to histogram shape) that cannot be expressed as fixed LUT.
- Fine-grained user edits should directly change the mapping; LUT must then be regenerated.

**LUT + helper layers advantages:**

- LUT handles the heavy lifting of 3D color mapping, while helper layers provide intuitive controls for tone, saturation, and protections.[^13][^11][^19]
- This hybrid approach is ideal for a plugin architecture: plugin updates LUT when core style changes; stack stays stable for minor tweaks.

## 7. Experimental Deconstruction Plan

The goal is to infer Match Color’s effective behavior via controlled experiments.

### 7.1 Test types and hypotheses

1. **Grayscale ramps.**
   - **Setup:** Source and target images as pure grayscale ramps (0–255). Apply Match Color between various ramp shapes (linear, gamma, S-shaped).
   - **Hypothesis:** If Match Color uses per-channel mean/std, grayscale-only tests will reduce to matching means/variances of single channel; curves should be approximately affine in intensity.[^2][^6]
   - **Measurements:** Compare input/output tone curves; fit linear/gamma models; compare histograms and CDFs.
   - **Conclusions:** Linear mapping supports mean/std model; complex nonlinear mapping suggests histogram or piecewise mapping.

2. **Single-hue bands.**
   - **Setup:** Source and target as horizontal bands of constant hues (e.g., pure red, green, blue) at varying luminance and saturation; apply Match Color.
   - **Hypothesis:** Per-channel mean/std or histogram methods will map bands based on statistical differences; measure whether mapping preserves hue or introduces cross-channel coupling.
   - **Measurements:** For each band, compute pre/post RGB, Lab values and plot differences; analyze if mapping is per-channel affine.
   - **Conclusions:** Per-channel affine mapping implies mean/std-like behavior; hue-dependent nonlinearities may indicate opponent-space operations.

3. **Same mean, different histogram shape.**
   - **Setup:** Create two images with identical per-channel means and variances but different histogram shapes (e.g., bimodal vs unimodal grayscale or color distributions).[^6]
   - **Hypothesis:** Mean/std-based Match Color will make minimal changes (since µ, σ already match), whereas histogram matching will still significantly alter pixel values to match CDFs.
   - **Measurements:** Compare ΔE distributions between input and output; compare histograms; measure KL divergence or Wasserstein distance before and after.[^12][^17]
   - **Conclusions:** Large changes despite equal µ, σ support histogram-based model; minimal changes support mean/std model.

4. **Same palette, different occupancy ratios.**
   - **Setup:** Source and target share identical set of colors but with different frequencies (e.g., image with 70% blue, 30% yellow vs 30% blue, 70% yellow).[^6]
   - **Hypothesis:** Mean/std methods may change colors despite palette identity, while histogram methods may map more strongly based on occupancy differences.
   - **Measurements:** Palette comparison; ΔE per color; histogram distances.
   - **Conclusions:** Degree of change reveals sensitivity to occupancy vs palette identity.

5. **Warm subject / cool background with selections.**
   - **Setup:** Images where only subject is selected as source region; match target subject but not background.
   - **Hypothesis:** Understanding how Match Color respects selections and whether statistics are computed only within selections informs its regional behavior.[^10]
   - **Measurements:** Compute statistics for selected vs full image; compare results.

6. **High-key vs low-key scenes.**
   - **Setup:** Source high-key, target low-key and vice versa.
   - **Hypothesis:** Observe how Match Color handles large differences in luminance distributions; mean/std methods often compress/expand contrast globally, while more sophisticated methods may introduce nonlinearity.
   - **Measurements:** Tone curve analysis via sampling; histogram comparisons; visual inspection for clipping.

7. **Casted neutral scenes.**
   - **Setup:** Gray card or neutral scenes under different color casts; apply Match Color with and without Neutralize.[^4]
   - **Hypothesis:** Neutralize acts like gray-world or chromatic adaptation, shifting mean chroma to zero; can be modeled by subtracting average a*, b* or performing Von Kries adaptation.
   - **Measurements:** Before/after mean chroma; Lab scatter plots; ΔE for neutral patches.

8. **Portraits with skin tones.**
   - **Setup:** Apply Match Color between portraits with different skin tones and lighting; measure skin tone regions separately from background.
   - **Hypothesis:** Match Color may treat skin no differently than other colors; any special handling is likely absent in legacy algorithm (skin-aware matching appears later in separate Adobe patents).[^14]
   - **Measurements:** ΔE in skin vs background; histogram comparisons per region.

9. **Saturated / clipped gamut edge cases.**
   - **Setup:** Highly saturated source and target images near RGB cube edges; apply Match Color.
   - **Hypothesis:** Investigate clipping behavior, gamut mapping strategies; mean/std methods tend to push values out-of-range, requiring clipping.
   - **Measurements:** Count of clipped pixels; mapping of edge colors; ΔE vs theoretical mapping.

### 7.2 Quantitative comparison metrics

- **ΔE (CIEDE2000).** Evaluate perceptual color differences between matched target and ground-truth/desired result.[^24][^26]
- **Histogram distance metrics.** Use L1/L2 differences, KL divergence, or Wasserstein distance between source-matched and source histograms to quantify distribution alignment.[^12][^17]
- **Tonal similarity.** Compare CDFs of luminance before and after; compute K-S statistic.
- **Hue and saturation shift analysis.** Plot histograms and angular differences in hue; analyze changes in saturation distributions.[^25]
- **Pairwise perceptual evaluation.** For each test pair, perform subjective A/B comparisons with experts rating perceived match quality; correlate with metrics to calibrate algorithm design.[^30]

Combining these metrics across test cases will help distinguish whether Match Color behaves like mean/std, histogram matching, or a hybrid.

## 8. Product / UX Recommendations

### 8.1 Plugin architecture options

1. **UXP panel with direct pixel processing.**
   - Plugin reads source and target layers as pixel buffers, computes transform (mean/std, OT, etc.), and writes result back to target as new layer or Smart Filter.
   - Pros: Full control over algorithm; can implement local/semantic transfers; can use any internal representation.
   - Cons: Harder to make non-destructive; to be fully non-destructive, must operate as Smart Filter on Smart Objects; less portable than LUTs.[^11]

2. **UXP panel that emits adjustment layer stacks.**
   - Plugin computes parameters (curves, saturations, Color Balance offsets) and programmatically creates adjustment layers with masks and Blend If settings.
   - Pros: Fully non-destructive; highly editable; integrates with existing workflows; no external file management.[^20][^19]
   - Cons: Limited to behaviors expressible via Photoshop adjustments; cannot perfectly represent complex 3D transforms; layer stacks can become complex.

3. **UXP panel that generates LUTs (Color Lookup layers).**
   - Plugin analyzes images, computes a 3D LUT, saves it (possibly temporary) and adds a Color Lookup adjustment layer referencing the LUT.[^13][^11][^16]
   - Pros: Encodes complex 3D mappings; GPU-accelerated; easy to toggle; portable to other software.[^15][^16]
   - Cons: LUTs are opaque; fine adjustments require regeneration; global-only unless multiple LUTs with masks.

4. **Hybrid: LUT + stack + Smart Filters.**
   - Plugin applies primary mapping via LUT, adds helper adjustment layers for tone/chroma protections, and optionally deploys as Smart Filter on Smart Object for direct-pixel fallback.
   - Pros: Best of all worlds; complex mapping with artist-friendly tuning; fits modern workflows.
   - Cons: Highest complexity to implement.

### 8.2 Recommended prototype and evolution

- **Best first prototype:** UXP panel with direct pixel processing implementing Reinhard-style Lab mean/std transfer plus simple controls (match amount, luminance strength, chroma strength, neutralize) and ability to output as either a new pixel layer or a Color Lookup layer with an internally generated LUT.[^3][^2][^6]
- **Best medium-term architecture:** Hybrid UXP panel that computes advanced OT/palette-based transforms, emits a Color Lookup layer for core mapping, and procedurally generates helper adjustments (Curves, Vibrance, Color Balance, masks) for tonal range weighting, preserve skin, preserve neutrals, and protect highlights.[^17][^14][^6]
- **Best long-term advanced architecture:** Smart Object–centric plugin that supports per-region, semantic, and potentially ML-based color matching (e.g., face-aware transfer) using local OT or learned flow models; plugin manages multiple LUTs and masks internally and can export presets.[^21][^38][^22][^14]

### 8.3 Artist-friendly controls and underlying math

For each control, the plugin should map slider values into simple parametric modifications of the underlying transform:

- **Match amount.** Scales overall strength of transfer: \(I_{out} = (1 - \alpha) I_{orig} + \alpha I_{matched}\), akin to Match Color’s Fade inverse.[^5][^10]
- **Luminance match strength.** Interpolate between original and matched L*; mathematically, scale the L* gain and offset or blend L* channels only.[^2][^6]
- **Chroma match strength.** Scale mean/std shifts or OT transport in a*, b* (or chroma channels) while leaving luminance fixed.[^2][^6]
- **Hue influence.** Control how much hue distribution is matched versus only chroma; for example, in Lab/HSV, limit angular adjustments in hue space via interpolation.[^6]
- **Tonal range weighting (shadows/mids/highlights).** Apply different α values per tonal zone (e.g., via smooth weighting functions in L*); in Photoshop, implemented via masked Curves or Blend If on LUT layer.[^18][^19]
- **Preserve neutrals.** Penalize or clamp hue shifts for pixels near the neutral axis (low chroma in Lab); mathematically, reduce transfer magnitude for small chroma radii.[^6]
- **Preserve skin.** Use face/skin detection (e.g., via color ranges or ML) to build masks and either reduce transfer strength or bias target skin toward reference skin tone cluster, similar to Adobe’s skin tone assisted matching patents.[^31][^14]
- **Protect highlights.** Reduce transfer in high-L* or high-luminance pixels to avoid clipping; implement via luminance-dependent attenuation of mapping.[^20]
- **Preserve contrast.** Constrain or regularize L* mapping to maintain local contrast; for example, match only global gamma but preserve local gradient statistics (or offer a slider that blends between full L* matching and contrast-preserving mapping).[^30][^25]
- **Cast neutralization.** Implement gray-world or Von Kries adaptation to remove global casts, optionally with strength slider.[^35][^3]
- **Gamut clamp / compression.** Map out-of-gamut results back into display gamut via soft compression near cube edges; control compression strength via slider.[^15][^6]
- **Local vs global transfer.** Slider controlling weight of global vs local components, e.g., blending between global transform and region-wise transforms based on segmentation.[^6]

These controls should be presented as a small, coherent set of sliders grouped into sections (Global Match, Tone, Color, Protection, Locality) to keep the UX approachable.

## 9. Implementation Blueprint

### 9.1 Prototype 1: Reinhard-style global match

**Algorithmic core:**

- Convert source and target to Lab.
- Compute µ and σ for L*, a*, b* over selected regions.
- Apply per-channel affine mapping from target to source as in Reinhard’s formula.[^3][^2][^6]
- Implement Neutralize option by subtracting average a*, b* from the mapped image (gray-world adaptation) or by re-centering Lab chroma around neutral.[^35][^3]

**Photoshop integration:**

- UXP panel allowing selection of source and target layers/regions.
- Buttons to: (a) apply result as a new pixel layer, (b) generate 3D LUT and insert Color Lookup adjustment referencing it.[^11][^13]
- Sliders: match amount, luminance strength, chroma strength, neutralize strength.

**Validation:**

- Compare against Photoshop’s Match Color using synthetic tests and ΔE metrics.
- Evaluate perceptual similarity via small expert panel.

### 9.2 Prototype 2: LUT-centric with helper adjustments

**Algorithmic enhancements:**

- Optionally switch to a decorrelated opponent space optimized via natural image statistics.[^27][^25]
- Add optional sliced OT step to refine mapping beyond mean/std, controlled by a “palette fidelity” slider.[^12][^17]
- Implement gamut-safe mapping back to RGB with soft compression.[^6]

**Photoshop integration:**

- UXP panel now always generates a 3D LUT (e.g., 33³ or 65³) and installs a Color Lookup adjustment layer for core mapping.[^16][^11]
- Procedurally generate helper layers for tone and chroma (Curves, Vibrance, Color Balance) with masks and Blend If for tonal zones.
- Add controls for preserve neutrals, preserve skin, protect highlights, tonal range weighting, and gamut compression; map them into LUT generation parameters and helper layer strengths.[^14][^18][^19]

**Validation:**

- Extend test suite to real composite and portrait images; evaluate against Match Color and expert hand-grading.
- Measure runtime performance and memory usage with LUT sizes.

### 9.3 Advanced version: Local, semantic, ML-enhanced

**Algorithmic features:**

- Integrate facial and skin detection (possibly via Adobe Sensei APIs or a local model) for skin-aware transfers inspired by Adobe’s skin tone matching patent.[^14]
- Implement segmentation-based local transfer (foreground vs background, sky vs ground) and blend with global component according to Local vs Global slider.[^6]
- Explore learned flow-based or hypernetwork-based color matching to approximate OT plans, enabling fast producer of complex mappings.[^21][^22]

**Photoshop integration:**

- Manage multiple LUTs (global and region-specific) with masks; or implement local transforms via direct pixel processing inside Smart Filters.
- Provide “analysis only” mode to show diagnostic overlays (e.g., skin mask, neutral mask, gamut compression regions).

**Validation strategy:**

- Use extensive real-world test sets (products, portraits, landscapes, composites); measure ΔE metrics for key regions and gather expert ratings.
- Conduct ablation studies to quantify benefit of each feature (OT, segmentation, skin preservation) on perceived match.

## 10. Final Takeaways

### 10.1 Top 3 most plausible Match Color models

1. **Primary model:** Global per-channel mean/std matching in an RGB-like or opponent space with controls for luminance scaling, chroma scaling, global fade, and neutralization.[^3][^8][^2][^6]
2. **Secondary model:** Hybrid of mean/std matching and limited histogram or palette adaptation to better handle tonal differences without full histogram specification.[^9][^8][^6]
3. **Less likely model:** Pure per-channel histogram matching in RGB with post-operators; referenced in applied literature but contradicted by academic attribution to mean/std transfer.[^37][^9][^8]

### 10.2 Top 3 best algorithmic approaches for a new plugin

1. **Reinhard-style Lab mean/std transfer as the baseline, with well-designed parameters for tone and chroma strength and neutralization.**[^3][^2][^6]
2. **Sliced optimal transport or similar distribution-matching refinement in Lab/RGB for high-fidelity palette matching, tunable via strength and regularization sliders.**[^23][^17][^12]
3. **Local/segmented transfer with skin-aware and neutral-aware weighting to preserve key memory colors and improve realism in portraits and composites.**[^31][^14][^6]

### 10.3 Top 3 Photoshop-native approximations

1. **Global match stack:** Curves for L* and channel adjustment, Hue/Saturation for chroma scaling, Color Balance/Curves for neutralize, and grouped opacity as Fade equivalent.[^4][^20][^19]
2. **Zoned + protective stack:** Add luminosity masks, Blend If, and skin masks to weight match by tonal range and protect skin/highlights.[^31][^18][^19]
3. **LUT-centric stack:** Use Color Lookup with a generated LUT for core mapping and helper Curves/Vibrance/Color Balance layers for artist control, plus masks for local refinement.[^13][^11][^16]

### 10.4 Recommended hybrid plugin strategy and R&D roadmap

- **Hybrid strategy:** Use a plugin to compute robust global color-transfer mappings in Lab space (mean/std + optional OT), encode the mapping as a 3D LUT for integration via Color Lookup, and surround the LUT with a procedurally generated, artist-editable adjustment stack for tone/chroma controls and protections (neutrals, skin, highlights, gamut).[^16][^2][^19][^6]
- **Prioritized R&D roadmap:**
  1. Implement and validate Reinhard-style Lab mean/std transfer and Neutralize in a UXP plugin; compare systematically to Match Color via the proposed test suite.[^8][^3][^2]
  2. Add LUT export/import and a LUT-centric stack generator; tune UI controls for match amount, luminance/chroma strengths, and protections.[^11][^13][^16]
  3. Integrate sliced OT or similar advanced color transfer core and skin/neutral-aware local weighting; design a semantic mask pipeline; run larger-scale perceptual evaluations.[^17][^12][^14]
  4. Explore learned mapping (flows, cmKAN-like) as optional high-end mode if user base warrants, always preserving LUT export and adjustment stack generation as the main Photoshop integration mechanisms.[^22][^21]

This roadmap yields an initial plugin that competes with or modestly outperforms Match Color on consistency and control, and an advanced architecture capable of delivering significantly superior matches in challenging real-world scenarios.

---

## References

1. [Match color between two images - Adobe Help Center](https://helpx.adobe.com/photoshop/desktop/adjust-color/selective-color-adjustments/match-color-between-two-images.html) - Learn how to use the Match Color command in Photoshop to make colors consistent between images in RG...

2. [[PDF] Color Transfer between Images - Semantic Scholar](https://www.semanticscholar.org/paper/Color-Transfer-between-Images-Reinhard-Ashikhmin/f3a11158e9d8bdfdf07dca756335c084fce0123e) - This work uses a simple statistical analysis to impose one image's color characteristics on another ...

3. [[PDF] Color transfer between images](https://home.cis.rit.edu/~cnspci/references/dip/color_transfer/reinhard2001.pdf) - This article describes a method for a more general form of color correction that borrows one image's...

4. [Photoshop's Match Color May Change The Way You See](https://www.johnpaulcaponigro.com/blog/17772/photoshops-match-color-may-change-way-see/) - Source Target Final Effect Photoshop’s Match Color Little explored and capable of opening up whole n...

5. [[PDF] Match Color](https://www1.udel.edu/cookbook/class/Tricks/matchcolor.pdf)

6. [[PDF] Color Transfer - Tania Pouli](http://taniapouli.me/wp-content/uploads/2016/08/Example-Based-Image-Manipulation-and-Enhancement-Pouli-SIGGRAPH-2012-Course.pdf) - This short course discusses color transfer, an exciting and creative approach to adjusting color con...

7. [Match color of two layers in the same image - Adobe Help Center](https://helpx.adobe.com/photoshop/desktop/adjust-color/selective-color-adjustments/match-color-of-two-layers-in-the-same-image.html) - Learn how to use the Match Color command in Adobe Photoshop to make one layer's colors consistent wi...

8. [[PDF] Understanding and Improving the Realism of Image Composites](https://graphics.cs.yale.edu/sites/default/files/2012sig_compositing.pdf) - Photoshop Match Color uses a standard color transfer technique similar to Reinhard et al. [2004]; co...

9. [[PDF] Research and Comparison of Facial Color Normalization Methods ...](http://ijeais.org/wp-content/uploads/2025/11/IJAISR251105.pdf) - Histogram matching is used in Photoshop (Match Color),. ArcGIS, and medical ... The algorithm of the...

10. [Matching Colors Of Objects Between Photos With Photoshop](https://www.photoshopessentials.com/photo-editing/match-color/) - Learn how easy it is to match colors of objects in separate photos using Photoshop's Match Color com...

11. [Edit a photo with color lookup adjustment - Adobe Help Center](https://helpx.adobe.com/ph_fil/photoshop/how-to/edit-photo-color-lookup-adjustment.html) - Add a Color Lookup adjustment layer. Open an image in Photoshop. Then, click the Adjustment Layer ic...

12. [[PDF] Fast Optimal Transport through Sliced Wasserstein Generalized ...](https://proceedings.neurips.cc/paper_files/paper/2023/file/6f1346bac8b02f76a631400e2799b24b-Paper-Conference.pdf) - The optimal transport plan has also been used successfully in many applications where a matching bet...

13. [Using the Color Lookup adjustment layer - Photoshop Tutorial](https://www.linkedin.com/learning/photoshop-advanced-adjustment-layer-and-blend-modes/using-the-color-lookup-adjustment-layer) - The color look up adjustment layer unlocks the power of LUTS, or look up tables. This is a powerful ...

14. [Skin tone assisted digital image color matching - Patent US-11610433-B2](https://pubchem.ncbi.nlm.nih.gov/patent/US-11610433-B2) - US-11610433-B2 chemical patent summary.

15. [What is the difference between a LUT and a Colour Profile?](https://www.motionforgepictures.com/what-is-the-different-between-a-lut-and-a-colour-profile/) - LUTs are used for colour grading to achieve a specific look, while ICC color profiles are used to en...

16. [Why Photographers Need To Use 3D LUT Color Grading Profiles](https://proedu.com/blogs/photography-fundamentals/why-photographers-need-to-use-3d-lut-color-grading-profiles) - Applying a 3D LUT is a transformative process, converting the flat log footage into a more visually ...

17. [Color Transfer via Sliced Optimal Transport](https://dcoeurjo.github.io/OTColorTransfer/) - The idea of this project is to detail a color transfer solution that considers the Optimal Transport...

18. [What is "Blend If" in Photoshop? - Photography Life](https://photographylife.com/blend-if-photoshop) - Blend If is the answer. Blend If takes a current layer and blends/masks it with respect to the under...

19. [How To Evaluate All Photoshop Color Adjustment Tools](https://www.johnpaulcaponigro.com/blog/16123/how-to-evaluate-all-photoshop-color-adjustment-tools/) - Vibrance provides only a very limited ability to selectively adjust colors with different levels of ...

20. [How to Use Levels & Curves in Photoshop - Day 6 - PHLEARN](https://phlearn.com/tutorial/30-days-photoshop-levels-curves/) - Levels and Curves are two of the most powerful Adjustment Layers in Photoshop! Learn how to make det...

21. [Color Matching Using Hypernetwork-Based Kolmogorov-Arnold Networks](https://arxiv.org/html/2503.11781v1) - We present cmKAN, a versatile framework for color matching. Given an input
image with colors from a ...

22. [Color Transfer with Modulated Flows - arXiv](https://arxiv.org/html/2503.19062v1) - Our technique is based on optimal transport and executes color transfer as an invertible transformat...

23. [Color Transfer via Discrete Optimal Transport using the sliced ...](https://codimd.math.cnrs.fr/s/2eRBqV9zl) - This code contains all you need to load and save color images (and to parse command line parameters ...

24. [The Delta-E Formula: Measuring Perceptual Color Difference](https://hex-to-rgb.com/knowledge/delta-e-color-difference) - Understanding Delta-E transforms subjective color matching into objective, measurable criteria, enab...

25. [Uniform color spaces and natural image statistics.](https://pmc.ncbi.nlm.nih.gov/articles/PMC3281518/) - ...L(*)a(*)b(*) spaces into cone-opponent space. All were elongated along a bluish-yellowish axis re...

26. [Proximity matters](https://pmc.ncbi.nlm.nih.gov/articles/PMC9271179/) - ...scientists learned how to predict when two lights with different spectral energy will look the sa...

27. [Color opponency is an efficient representation of spectral properties in natural scenes](https://pmc.ncbi.nlm.nih.gov/articles/PMC2940112/) - Vision Res. Author manuscript; available in PMC: 2010 Sep 16.

*Published in final edited form as: *...

28. [Effects of L*a*b* color parameters on perceived smile attractiveness.](https://linkinghub.elsevier.com/retrieve/pii/S002239132500037X) - STATEMENT OF PROBLEM Despite the importance of tooth color in smile esthetics, an understanding of h...

29. [Comparison of Different Digital Color Measurement Methods on Maxillary Anterior and Canine Teeth: A Clinical Observational Study.](https://www.semanticscholar.org/paper/2f8714371f288003e222d73bc4331985f750b718) - PURPOSE This clinical observational study aimed to determine the reproducibility of digital color me...

30. [Colour and luminance contrasts predict the human detection of ...](https://pmc.ncbi.nlm.nih.gov/articles/PMC5627170/) - Much of what we know about human colour perception has come from psychophysical studies conducted in...

31. [Paradoxical impact of memory on color appearance of faces](https://www.nature.com/articles/s41467-019-10073-8) - What is the function of color vision? Here, the authors show that when retinal mechanisms of color a...

32. [How to Color Match in Photoshop | Boris FX](https://borisfx.com/blog/how-to-color-match-in-photoshop-boris-fx/) - In Photoshop, you can access the Match Color using the keyboard shortcut CTRL+ALT+Shift+L on Windows...

33. [Photoshop Tutorial: Steal the Color & Tone of an Image with Match Color  -HD-](https://www.youtube.com/watch?v=qCOy113upDw) - ▶ Like us on Facebook: http://facebook.com/RiverCityGraphix
▶ Follow us on Twitter: http://www.twitt...

34. [MATCH COLOR Photoshop workflow demo @ SCCA](https://www.youtube.com/watch?v=2NEH2QtSwGM) - Photoshop workflow demo @ SCCA

35. [Mechanisms of color constancy under nearly natural viewing | PNAS](https://www.pnas.org/doi/10.1073/pnas.96.1.307) - Color constancy is our ability to perceive constant surface colors despite changes in illumination. ...

36. [All Your Pixels Are (Probably Not) Belong To Pantone - Hackaday](https://hackaday.com/2022/10/29/all-your-pixels-are-probably-not-belong-to-pantone/) - This is a service, Pantone provides physical chips to match color to what you think you see on your ...

37. [Histogram specification? - Processing - discuss.pixls.us](https://discuss.pixls.us/t/histogram-specification/9538) - Does Gimp have a Match Color function similar to that in Adobe Photoshop? software, color, white-bal...

38. [Deep Preset: Blending and Retouching Photos with Color Style Transfer](http://arxiv.org/pdf/2007.10701.pdf) - End-users, without knowledge in photography, desire to beautify their photos
to have a similar color...

39. [A machine learning approach to color space Euclidisation](https://onlinelibrary.wiley.com/doi/pdfdirect/10.1002/col.22897) - In this work, a machine learning methodology is proposed for the issue of color space Euclidisation....

40. [Fast Color Space Transformations Using Minimax Approximations](http://arxiv.org/pdf/1009.0854.pdf) - Color space transformations are frequently used in image processing,
graphics, and visualization app...

