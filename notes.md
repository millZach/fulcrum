# Fulcrum

## 2026-08-24 — 388 green tests, and the browser still found two bugs the suite couldn't

Clicking through the full M2 flow caught what 384 unit tests missed: two hero assets with byte-identical replay GLBs shared one durable submission row (the idempotency key was content-only, no asset identity), so the second asset tripped the first's in-flight marker and blocked the whole project with "submission-unknown" — in replay mode, where no money exists. Fixed, re-ran the walkthrough, and the browser immediately caught bug two: my `.env` had `FULCRUM_MESHY_MODEL=meshy-6`, which silently switched replay's multiview capability off, while the regeneration decider read capability from the policy allowlist instead of the adapter — so it picked change-views, burned its one bounded attempt on a byte-identical request, and gave up. Vitest never loads `.env`, which is exactly why the suite stayed green both times. Two fixes, six new tests, and the demo path now validates heroes in 2 attempts. The walkthrough is not a formality.

## 2026-08-24: A fresh snapshot rewound the screen after a paid regeneration

I reproduced the slot jump with a 6,000 ms replay regeneration: the POST returned slot 02 r02, then an effect keyed to the new concept-set revision cleared the browser selection and exposed slot 01 r01. I made review state project-scoped, moved intentional form cleanup into the actions that own it, and found the same poll-triggered reset pattern in interrogation drafts, visual-direction notes, and sound notes; slot 02 r02 now survives the response and six 2.5-second poll intervals.

## 2026-08-24: Subscription ImageGen was charging a fictional penny

I traced every $0.01 subscription image charge to a fixed bookkeeping reserve, not provider usage: the runner returned $0.00, but the durable image path reserved one cent and copied that reserve into every cost record. I removed subscription routes from budget mechanics, kept the API and ElevenLabs caps intact, and added typed 429/quota warnings as the honest usage brake.

## 2026-08-24: A guard read "keep the palette" as "change the palette"

I traced a 32-second focused-change refusal to a guard that classified words in the user's note, then rejected any category whose name matched a pin without checking the returned document. The fix compares the actual pinned field, tolerates casing, whitespace, and list order, and tells the model the exact field/value pairs to echo; an 8,000 ms replay run proved the wait banner stays visible and a real pinned-lighting change refuses with the note intact and a working Dismiss button.

## 2026-08-24: Reload erased a model wait that could last three minutes

I reproduced the continuity gap with a 20,000 ms replay delay: the server kept working after reload, but the tab lost its only `working` flag and never fetched the completed snapshot. The fix is an in-memory per-project action marker plus a shared promise for exact duplicates; the studio seeds its clock from the server timestamp and polls every 2.5 seconds when no local POST owns the wait. A two-tab Playwright run proved the stale tab advanced from round 2 to round 3 on its own, and both reload clocks matched server elapsed time.

## 2026-08-24 — A 24-second fallback outran a throttled 11-second animation queue

I reproduced the tower snap by pausing `requestAnimationFrame`: the fixed watchdog changed 5 active cubes to 11 while Rusty was still on `Wave`, because the renderer discarded all but 60 ms of elapsed time. The fix gives each pending tower level its own 24-second window and keeps the render clock's full delta; an eight-second mid-placement stall now catches up 135 ms after frames resume. The caption overlap was a second concrete bug: `parseFloat("clamp(...)")` killed the capture dock, so I now measure a laid-out tile's resolved pixel width and Rusty's canvas stays 16 px above the caption.

## 2026-08-23 — Rusty's walk was pure theater: the tower rendered before he placed it

Two bugs, one root: the world render took raw decision counts, so a 3-answer round popped three levels of blocks instantly and Rusty's pick-up-walk-place animation was replaying what already happened — and the capture dock's fixed scene offset clipped the tower's top out of frame. The fix was a pure choreography reducer (one trip per world level, instant sync on page reload, collapse past the 6-level cap) plus sizing the dock with CSS container queries from the actual isometric math: the build is 6.24 units tall, so the unit now clamps to what the frame can hold. A Playwright harness proves the order — blocks land at +9.3s, +11.0s, +10.9s after a round, never at 0s.

## 2026-08-23 — The mascot's gutter assumed a layout cap the stage doesn't use

An adversarial review pass caught Rusty's crate poking out of his world panel, but only between 1640–1800px wide and on 1080-tall windows — three viewports I'd screenshotted were all clean. The mascot's `--vx-gutter` assumed the 1640px content cap at every width, but the stage actually caps at 1450px in that band, so every anchored box sat ~95px too far right; tall windows hid no margin to absorb it. Fix was three CSS lines restating the gutter per breakpoint. Lesson: test the widths between your breakpoints, not just at them.

## 2026-08-23 — One position:fixed silently killed every mascot dock

Filmed Rusty floating over the wrong panel when the studio scrolled and assumed a scroll-sync bug. The real damage was bigger: `position: fixed` nulls `offsetParent`, so the dock measurer bailed on its first check and every dock studio-wide — capture, panel, finale — had been silently dead, leaving all screens on viewport-fixed free parking. Fix was structural, not a scroll listener: mount the mascot inside the `.vx-stage` scroller so free parking and docks resolve in scrolled-content coordinates and he rides the compositor with his scene. Verified at three viewports with a Playwright suite asserting his offset to each anchor stays within 2px under scroll, even wheeling during the first two seconds of load.

## 2026-08-22: Mastra wrapped the useful Error twice

I traced the M0 `"[object Object]"` blocked message to Mastra returning a wrapper with a useless serialized `message` and the real Error nested under `error`. The fix unwraps that Error, preserves strings, and caps JSON output for other objects at 2,000 characters so a failed phase leaves a reason a human can act on.

## 2026-08-22 — ElevenLabs output_format is a query param, not JSON

The sound-generation docs put `output_format` on the URL (`?output_format=mp3_44100_128`), not in the JSON body with `text` / `duration_seconds` / `loop`. Easy to drop into the body next to `model_id` and get a 400. Replay never calls it; the `none` adapter writes a 22.05 kHz 16-bit mono WAV from sha256(prompt) so M1 can finish without a key.

## 2026-08-22 — 91 green tests, and the first real API call was a 400

Wired M1's creative text to a live model. Every test injects a fake
executor, so nothing ever ran the Zod-to-JSON-Schema conversion the
real route uses — 91 tests green, then the first real call rejected the
spec schema outright: strict mode demands every object's `required`
list every property, and one nested field was `.optional()`. One smoke
call against the actual API caught what the whole suite couldn't. Fix
was strict-compatible output schemas plus a walker test that asserts
the invariant deterministically. Fakes validate your logic; only the
real thing validates your contract.

## 2026-08-22 — Cache key was missing the one thing that varies

While making concept prompts user-editable I found the ImageGen
idempotency key never included the prompt: same slot, same attempt,
different regeneration note would have served the cached image instead
of calling the API. Invisible until now because prompts were derived
from the keyed inputs; the moment users can edit them, the key lies.
Fix was hashing the prompt into the key. Lesson: a cache key must
contain everything that changes the output, not everything you happened
to have on hand.

## 2026-08-22 — Invented mascot frames made Rusty a giant

Task G wrapped the studio home/signoff/game-design dioramas in
`data-mascot-frame="capture"` that the prototype never uses, so
`measureDock` filled those columns and Rusty rendered at ~1034×459
instead of the free-mode 560×419. I stripped the extra frames, sized
the worlds to the prototype's stage fill so they keep the 711/1028
aspect, and let CSS park him as the small corner robot again. Same
thing on the complete screen: Task F's max-content stage rows collapsed
the finale's `height:100%` world to a 364px band, and restoring the
prototype's 1fr stretch filled it to 725px.

## 2026-08-21 — Regen was a one-shot; budget is the real gate

The coordinator threw after the first concept regen, so a later direction
change that staled that slot deadlocked the project. Zach's call: regenerate
as many times as it takes, and let `reserveBudget` refuse at $0.01 a shot.
I ripped the cap, added `POST /api/projects/:id/budget` so a
`budget-refused` key can resume after a raise, and the same idempotency row
stays on `intent-recorded` until the fake runner actually runs.

## 2026-08-21 — JS .click() hid an unscrollable studio

The shared-understanding CTA sat 26px under the fold at 1920×911 and
nothing on the page could scroll. Playwright (and I) kept calling
`.click()` on the button, which ignores visibility, so the layout bug
never showed up until a real mouse got stuck. The prototype's screens
each own an overflow-y panel; M1Studio didn't, and the World Forge
shell is `height: 100vh; overflow: hidden`. Stage is now the scroller,
scoped under `.m1-studio` so the prototype stays put.

## 2026-08-21 — Direction approval needs a hash the snapshot did not have

Wiring World Forge to the real M1 coordinator, I could approve a Game Design Spec from `state.gameDesignSpec.artifact.sha256` and a concept set from `state.conceptSet.artifact.sha256`, but visual-direction approval targets the _bible_ revision, not the direction set. `VisualDirection` only carries `revisionId`. Tests cheat with `repository.getRevision()`. The UI cannot. Additive snapshot field `visualDirectionRevisions` (revisionId → RevisionRef) unblocked the approval POST without changing the stored direction document.

## 2026-08-21 — Budget refusal was poisoning paid idempotency keys

Live Meshy submit reserved budget and checked env before fetch, then the ensure() catch treated that throw like a mid-flight provider failure and wrote `submission-unknown`. Topping up the budget did nothing; the same key was stuck on "will not create another paid job" even though Meshy never saw the request. Fix was a typed preflight refusal (`budget-refused` / `provider-unconfigured`) that stays on `intent-recorded` so the key is retryable, and only an actual fetch throw still goes unknown.

## 2026-08-21 — Grok's headless mode fails by succeeding

First two Grok CLI subagent runs burned 11 minutes combined, exited 0, and changed nothing. In print mode the first tool call that needs interactive approval cancels the whole run with stopReason "cancelled" and a clean exit code, and --permission-mode acceptEdits is simply not honored there, so both agents read the repo, narrated a plan, and died the moment they tried to edit. A 4-cent probe run with --output-format json exposed the stopReason; --permission-mode auto was the only mode of five that actually completed. Third launch with auto: both agents landed their full tasks.

## 2026-08-21 — `inferCamera` trusted array order, and `/\blight\b/` cannot see moonlight

The M1 camera picker walked a fixed keyword list and returned the first hit in array order, so "do not use an isometric camera" beat an explicit side-scrolling answer because isometric sits earlier in the list. Same function had no idea what negation was. The focused-change classifier had the sibling problem: `\blight\b` does not match moonlight, so a lighting revision fell through to vfx, reported success, and left the bible's lighting field untouched. Fix was first-positive-mention with answer-over-brief precedence, stem matching, and fail-closed classification that actually replaces the superseded token instead of concatenating it.

## 2026-08-21 — CORS on :4310 does not protect the Vite proxy

The prototype ImageGen POST was wide open because `cors({ origin: true })` reflected any Origin, so a tab at evil.example could POST to 127.0.0.1:4310 and spend the signed-in OpenAI subscription. Tightening CORS was not enough on its own: the studio Vite proxy on :4311 forwards the browser's Origin, and the tab never sees the orchestrator's CORS headers. The fix is an explicit studio allowlist plus a 403 on the ImageGen route when Origin is not on it. Missing Origin is allowed (curl / local scripts); browsers always send Origin on a cross-origin POST, so a CSRF page cannot omit it.

## 2026-08-20 — A MutationObserver without `subtree: true` hid a bug for two hours, and unmounting a WebGL canvas found another

Rusty had to vanish on the three image-review pages, so I watched the shared concepts component's DOM to find out which of its four screens was up — `observer.observe(host, { attributes: true, attributeFilter: ["class"], childList: true })`. My probe kept reporting the right class name (`single-concept-review`) _and_ one canvas still on screen, which made no sense until I re-read the MutationObserver contract: `attributeFilter` only applies to the node you observe, and React keeps the same `<div>` across all four screens and just swaps its className, so there was never a childList mutation and never an attribute change on the host. One word — `subtree: true` — and it worked first try. That immediately produced a second bug: with the canvas actually unmounting, react-three-fiber threw `Cannot read properties of null (reading 'addEventListener')`, because its `run()` is `await root.configure(...)` and the `onCreated` continuation lands after the component is gone and connects its pointer events to `divRef.current`, which is now null. The mascot is `aria-hidden` decoration that nothing ever points at, so the fix was `events={() => ({ enabled: false, priority: 0 })}` — an event manager with no `connect` at all, which r3f's `?.` guard skips.

## 2026-08-20 — Turning the whole workshop 90° was the only way to make him walk _toward_ the grid

The baked clips put the block down 0.94m straight in front of his seat, and no re-timing moves that, so to get him walking at the diorama instead of back at his own stool I rotated the entire rig group and let the fixed root motion point wherever the group points. First guess was -45°, which aimed the walk beautifully and rendered his stool and crate as flat grey slabs — a box at yaw ≡ 45 (mod 90) presents one face dead square to a 45° isometric camera. A sweep over yaw showed -90° is both the best box read (45° off-square) and the smallest placement gap (0.360m ≈ 27px below the plate's near corner at zoom 76), so that's what shipped. The unavoidable cost: on a fixed 45° iso camera, "walks up-screen toward the grid" and "we can see his face while seated" are the same axis with opposite signs — he now works with his back three-quarters to us on the diorama screens, and keeps the face-on yaw 0 everywhere he is only parked.

## 2026-08-20 — The robot docked 8px off, and it was an entrance animation lying to getBoundingClientRect

Moving the mascot _inside_ the build-log's little capture window meant measuring that window and parking his canvas exactly on it. Simple job, except he kept landing at 167/341 when the frame was at 159/305 — 8px right, 36px down, 6px too narrow — and only on the first paint after a screen change. I chased z-index and offsetParent for a while before spotting the real culprit: `.vx-stage` plays a 0.5s `vx-stage-in` slide, and `getBoundingClientRect()` returns the _painted_ rect, so I was measuring a box that was still moving. Fix was to stop asking for painted geometry entirely and walk the `offsetLeft/offsetTop/offsetWidth` chain up to the offsetParent — transform-free, and it resolves against exactly the same boxes his own `left`/`top` do — plus read the diorama plate's ground line as a _fraction_ of the painted frame so any in-flight scale/translate divides back out. Exact match at 1920, 1400 and 1280. The other hour went on proving the block actually lands in the grid: the flight is 0.6s, Playwright screenshots are 200-300ms apart, so I couldn't see it. Switched to `recordVideo` + `ffmpeg fps=25` frames + a montage, temporarily stretched the tween to 2.0s to confirm the arc terminates on the target cube, then put it back.

## 2026-08-20 — An inline `pointer-events: auto` I never wrote ate every click behind the mascot

Promoting the 3D mascot from one screen to all eight of the World Forge screens, the first walkthrough died on `.vx-spec button` with Playwright's "subtree intercepts pointer events" — a transparent robot standing in a corner was swallowing clicks meant for the button 400px away. I had `pointer-events: none` on the dock _and_ on `.vx-mascot *`, so I spent a while assuming a stacking-context problem; react-three-fiber writes `pointer-events: auto` inline on its own wrapper div, and an inline style beats any stylesheet rule no matter how specific. One prop — `style={{ pointerEvents: "none" }}` on `<Canvas>` — and every click landed again. The other hour went on parking him on the final approval screen, where three concept cards and two buttons use literally every pixel: the honest answer was that he can't stand anywhere, so `:has(.concept-complete)` and `:has(.concept-plan-review)` now give those two screens their own docks — a 104px perch up on the header rule for the gallery, a full-size send-off spot above the "M1 is complete" card. Also worth remembering: to put a fetched block in his claws, `Object3D.attach()` on the exact marker frame beats decoding the rig's carry-offset quaternion, because the hand is already closed around the block's pickup pose at that frame and attach() just keeps the world transform.

## 2026-08-20 — drei's contact shadow needs to sit BELOW y=0, and Chrome won't screencast 30fps

Three hours on the mascot's first day in the app, all three on things that look like config typos. First: I dropped `<ContactShadows position={[0, 0.004, 0]}>` under the robot to ground him and got nothing — not faint, nothing, even at opacity 1 in red. drei renders its two blur passes against a hard-coded plane parked at the _world origin_, viewed by the shadow group's own camera looking straight up. Put the group at +4mm and that plane is 4mm behind its camera, so every blur pass clips it away and hands back an empty texture. Moving to `[0, -0.01, 0]` — a centimetre below the floor, visually identical — and the shadow was there all along. Second: recording the 1920x1080 promo, Chrome's CDP screencast caps out around 28fps and jitters to 156ms, so a 30fps encode stuttered. Fix was to run the page at 0.15x — override `performance.now` via addInitScript for the JS/three clock, `Animation.setPlaybackRate 0.15` over CDP for the CSS animations — then resample by timestamp onto an exact 30fps grid in animation time. 113 effective source fps, zero duplicated frames. Third, and the one that cost the most: the first take kept showing a 1.2s poof playing out in 0.3s. Screencast timestamps are _delivery_ times, not content times — after any compositor stall (a reload, or a React remount that recreates the WebGL context) Chrome hands back the last stale surface and then catches up over the next few frames, so half a second of real animation gets crammed into a handful of frames at the head. No amount of resampling fixes it because the timestamps lie. Fix was to hold back the GLB response with a Playwright route for 18s so the workshop reloads, stalls, and fully catches up while the mascot is still waiting on his model — his intro then starts in clean, honest frames.

## 2026-08-20 — Two sign errors and a leftover pose entry ate most of a day

Building the robot's decision loop (walk to a pile, grip a block, carry it back), the claws kept ending up 175mm from the block with no complaint from the IK. Spent ages auditing the grip geometry, the crouch depth, the arm reach — all fine. The bug was that my pose dicts were layered: the base standing pose sets an `aim` for the ForeArm, and my grip pose overrode the Arm with a two-bone IK spec. `apply()` sorts bones parent-first, so the IK solved the whole arm and then the leftover ForeArm aim re-aimed it and dragged the hand off the target. Two-line fix in `apply()`: a bone that is an IK chain's mid bone ignores any other spec. Before that I'd burned an hour on a _different_ sign: the library's docstring says "+X rotation swings limbs backward, spine −10 = lean forward". Measured it — it's exactly the opposite (+20 on Spine02 drops the shoulder 0.16m toward his toes), so every crouch I'd authored was leaning him _backwards_ away from the block. Lesson for this rig: measure the mnemonic before you trust it, and never leave a stale `aim` under an IK override.

## 2026-08-20 — A 14° toe-off buried the boot 38mm in the floor

The robot's walk cycle skated: 30mm of contact-patch travel per frame on a planted foot. Three separate causes, all measured rather than guessed. (1) Pitching the ankle for toe-off rotates a 0.35m boot about a point 0.135m above its sole, so the toe drops 38mm and drags back 30mm — fixed by moving the ankle along the pivot `c − Rx(θ)·c` (toe for toe-down, heel for heel-strike) and closing the loop on a measured residual. (2) The pitch ramp reached its peak one frame _after_ the foot left the ground, so the boot rotated 8° in a single frame at every step. (3) A planted foot was being aimed with the _current_ body yaw, so during a 150° turn-on-the-spot it spun in place — a planted boot has to keep the yaw it was planted with. Worst per-frame slip went 30mm → 2mm, and the leftover 7-12mm is all on the two frames either side of a landing, where slerping between two IK-solved key poses swings the blended ankle off its plant. Fixed that one structurally: any leg that is IK'd in both surrounding keys gets re-solved every in-between frame against the interpolated target.

## 2026-08-20 — "Where does he sit?" cost me four wrong answers before the right one

Retargeting the DangleIdle onto the new robot mascot, the whole job came down to one number: how high to lift his hips so he lands on the block instead of in it or above it. I let the code solve it by measuring the lowest body vertex, and got four different answers because I kept feeding it the wrong body. Lowest point of everything: 0.60m of lift, him floating in mid-air, because the dangling boots hang 47cm below the seat. Excluding the boots: 0.24m, because the arms IK to hand targets defined relative to a seat that doesn't exist yet. Excluding the arms: still wrong, because the thighs slope down over the front edge and _cross_ the ledge corner — that's contact, not penetration, and treating it as penetration parked him 10cm clear of his own seat. The right answer was the pelvis floor alone, a 45mm-deep pad, giving 0.134m. Second thing that bit me the same session: this robot stands with his legs at 99.4% extension (hips 0.556m up, thigh+shin 0.428m), so the worker's 30mm hip weight-shift put the far foot out of IK reach and the clamp slid it 22mm across the floor. Shrinking the shift to 24mm across and 10mm _down_ instead of up took the slip to 1.4mm.

## 2026-08-20 — The "74mm boot clip" was his hands, on every single frame

The mascot's dangle-idle audit reported 74.2mm of boot/shin inside the plinth at frame 79, so I went looking at the kick arc. Wrong tree entirely: dumping the penetrating vertices by dominant bone showed RightHand 74.3mm and LeftHand 63.0mm, identical on all 90 frames. The old audit sampled every 3rd frame and just printed the first one it hit, which made a constant defect look like a one-frame event. The real cause is that the gloves on this model are 0.29m long and 0.16m deep, and the approved pose aimed them nearly straight down from a wrist only 0.152m above the seat, so both mitts were sliced off flat by the plinth cap. A 96-point grid search over wrist height and mitt angle against the actual audit metric found the fix: lift the wrist 30mm, lay the mitt at 15 degrees below horizontal instead of 70. Arms stay braced at 89% extension (were 91%), so the silhouette Zach approved doesn't move — only the wrist angle — and the audit goes to 0.00mm.

## 2026-08-20 — Pose-bone scale is in BONE axes, so my squash flattened him sideways

Adding squash-and-stretch to the mascot's poof, I set the Hips pose-bone scale to (1,1,0.9) expecting a vertical squash and got a character who was flattened front-to-back and hovering 10cm underground. Pose-bone scale applies along the bone's OWN axes, and this rig's Hips bone has local Y pointing at world +Z — so my "vertical" 0.9 went into world depth and the 1.0 I meant for depth went into height. Writing the scale in world axes and permuting it into bone axes (matching each bone-local column to its nearest world axis) fixed it; the Hips axes are within 16 degrees of world, so the leftover shear is about 2% of lean at a 7% squash, which reads as life rather than error. Second gotcha from the same clip: analytically compensating the root so the boots stay on the floor isn't enough, because pointing the toes drops the toe tip further than the scale does. Measuring the lowest deformed vertex and shifting the root by the difference put it at exactly 0.0000.

## 2026-08-19 — The mascot's thumb was skinned to his thigh, not his hand

Fulcrum's wave had a thin brown ribbon smearing from his raised mitt down to his armpit. I assumed the thumb verts were stuck on the ForeArm bone, but a dominant-group dump near the wrist came back 100% clean, which sent me the wrong way for a while. The real culprit: Meshy's auto-rigger binds by proximity in the A-pose, where the gloves hang right next to the thighs — so 439 right-glove and 427 left-glove vertices carried RightUpLeg/LeftUpLeg weight, outweighing the Hand bone outright on ~40 of them. Raise the arm and the thumb literally stays behind with the leg. My first fix attempt selected the glove with a sphere around the wrist and that was worse than the bug — in the A-pose a 22cm ball around the wrist also swallows the thigh, so it hard-bound his leg to his hand. Flood-filling the mesh from confidently hand-weighted verts and refusing to step back past the cuff got exactly the glove, because the only way out of the glove island is up the forearm. Worst-case vertex error went from 1124mm to 32mm, and the 32mm is just the wrist crease doing its job.

## 2026-08-19 — object-fit: contain was cropping a "full frame" image anyway

A preview image labelled FULL FRAME was visibly cropped on a 2048px laptop even though it already had `object-fit: contain`. Contain only fits the picture inside the _element box_ — and because the img was a centred (non-stretched) grid item, its own box was sized from the intrinsic 1672x941 picture, not the frame, so `height: 100%` resolved against that content-sized track and the element overflowed its `overflow: hidden` parent by 149px. Two lines of `position: absolute; inset: 0` pinned the box to the frame and it letterboxed correctly at every size. Same session: adding a pixel sprite to a CSS-3D isometric diorama, chimney smoke sitting on a cube's top face got sorted _behind_ that cube no matter how far I pushed it toward the camera — I stopped fighting Chrome's 3D sorting and projected the point by hand into a plain 2D overlay outside the scene.

## 2026-08-19 — One backdrop-filter cost 4ms a frame at 2048px

The finished world screen ran at 20.6ms/frame on a 2048px viewport and I assumed it was the new sprite and block animations. Bisecting by disabling one animation at a time proved all of them were free: the entire cost was `backdrop-filter: blur(8px)` on the 62px topbar, which a slow-drifting background wash underneath forced Chrome to re-blur every single frame. Deleting it took every viewport to a flat 16.6ms — and since what it was blurring was a flat 16px grid, nobody can tell.

## 2026-08-19 — A blanket min-height reset made a grid crush instead of scroll

While rebuilding the two M1 prototype finalists, helper text kept painting underneath a sticky button even though the browser swore nothing overflowed (scrollHeight equaled clientHeight). The culprit was a blanket `min-height: 0` reset on every element in the column: it stripped CSS Grid's automatic minimum row sizes, so a column needing 576px in 549px silently crushed its rows — a 50px paragraph got a 17px row — instead of scrolling. Restoring `min-height: auto` on the content rows fixed it in one line. Bonus lesson: when the remote preview browser hung, a local Playwright walkthrough script proved the page itself ran at a steady 60fps in about a minute.

## 2026-08-19 — One stopped preview left four background jobs behind

I stopped the newest Vite server, but T3 still showed background work because two orchestrators, an older Studio server, and a temporary docs server were each running in separate process groups. The fix was to identify the exact child groups under the T3 app server and terminate only those four groups, leaving T3 itself alive and closing ports 4310, 4311, 4313, and 4320.

## 2026-08-18 — Style labels were not enough to make a prototype readable

I pushed the voxel option into a strong theme, but its purple field and 7–9 px labels made the interface feel decorative instead of usable. I rebuilt it around a warm off-white workspace with a visible 7-second 2D-to-3D world transformation, then raised the small copy in both finalists to 9–17 px and replaced the review room's generic pitch line with a concrete invitation.

## 2026-08-18 — A theme has to survive the whole workflow

I pushed the prototypes toward cyberpunk and pixel/voxel extremes, but the shared concept-review component initially snapped both designs back into Fulcrum's existing editorial look. The fix was to theme the reusable workflow surface too, so each option now keeps its own visual language from the first prompt through concept planning without forking the underlying state model.

## 2026-08-18 — Polished dashboards were still just dashboards

I replaced two rejected layouts with cleaner software panels, but they still shared the same generic dashboard grammar and taught us nothing new. The useful reset was to change the interaction metaphor itself: one prototype now behaves like an in-engine world forge, while the other behaves like a physical story-room wall with pinned evidence and full-size prints.

## 2026-08-18 — A global header style leaked into the visual lab

The new light visual-development prototype inherited Studio's unscoped `header` background and turned its main title into black text on a black panel. I explicitly isolated the nested prototype header, then tightened the direction-review geometry so the full artwork, thumbnails, actions, and design switcher all remain visible together at 1280×800.

## 2026-08-18 — A custom pitch exposed scripted project assumptions

I entered a walking-city game into the prototype and it immediately asked why the player should leave a lighthouse, revealing that custom input was only cosmetic. I replaced the scripted game facts with domain-neutral design questions and workflow truths so any pitch can honestly exercise the interface while saved Hollow Signal art remains clearly prototype material.

## 2026-08-18 — The prototype switcher was mistaken for product state

I had hidden three application-design explorations inside a workflow demo, so their A/B/C labels looked like choices the user was supposed to make in Fulcrum. I made each design start from the user's own project brief, carry one shared state through the full journey, and preserve the complete visual-direction artwork instead of cropping it to the layout.

## 2026-08-18 — Generated did not mean approved

I built the first M1 concept flow so image generation silently selected every first revision, then squeezed all three images into a clipped gallery that was too small to judge. I split planning from generation, gave every image its own uncropped review page, and made each generated revision stay unselected until the user keeps it. The last seam was replacing a fake prompt replay with a real signed-in ImageGen edit: a browser-entered request now creates a durable local revision in about 84 seconds, without an API key.

## 2026-08-18 — The concept lineage had IDs but not proof

I had M1 concept prompts pointing at their source revision IDs, but an adversarial integration pass caught that the documents still could not prove which immutable bytes they inherited. I added an M1-only ancestor manifest with the revision ID, artifact SHA-256, and kind for every creative source while leaving the M0 concept format untouched; the replay tests now verify the exact Game Design Spec and visual-direction hashes.

## 2026-08-18 — The first live run found three integration seams

I found that the orchestrator loaded `.env` relative to its package, a bodyless polling POST still advertised JSON, and Meshy's valid 1.9 m output rendered tiny in the authored arena camera. I fixed root-relative runtime configuration, made JSON headers conditional on an actual body, and normalized provider GLBs to the 3.2 m review target before grounding them. The same paid Meshy job resumed safely throughout, passed all six QA gates, and consumed 30 credits without a duplicate submission.

## 2026-08-18 — Reused the Codex subscription for ImageGen

I initially treated GPT Image 2 as API-only and made Studio request a key even though Codex exposed an enabled `image_generation` capability. The fix was to detect that capability separately, invoke ImageGen through an isolated `codex exec` job, and keep the API route only as the fallback.

## 2026-08-17 — Closed the duplicate-spend crash window

I found that journaling a provider job only after its response left a narrow restart window where Fulcrum could pay for the same request twice. I now record intent and pending state before network I/O, turn interrupted calls into `submission-unknown`, and have a regression test proving Fulcrum refuses to submit that job again automatically.
