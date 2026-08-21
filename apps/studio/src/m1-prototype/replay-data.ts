export type M1Stage = "understand" | "direction" | "concepts";

export type Direction = {
  id: string;
  index: string;
  name: string;
  thesis: string;
  shape: string;
  material: string;
  light: string;
  palette: string[];
  artClass: string;
  image: string;
};

export const stages: Array<{ id: M1Stage; label: string; note: string }> = [
  { id: "understand", label: "Shared understanding", note: "2 decisions open" },
  { id: "direction", label: "Visual direction", note: "Choose one" },
  {
    id: "concepts",
    label: "Required concepts",
    note: "Confirm plan, then review",
  },
];

export const questions = [
  {
    branch: "Core loop / failure",
    prompt:
      "What should the player do most often, and what pressure keeps that loop from becoming routine?",
    recommendation:
      "Name one repeatable player action, one escalating pressure, and one consequence the player can understand and recover from.",
    why: "A concrete action-pressure-consequence loop gives the rest of the design a stable center without prematurely inventing content for your game.",
  },
  {
    branch: "Camera / readability",
    prompt:
      "What must the player read immediately, and what information is allowed to remain uncertain?",
    recommendation:
      "Keep the next meaningful action and immediate hazards legible; reserve ambiguity for discovery, story, or longer-term strategy.",
    why: "Separating actionable information from intentional uncertainty protects fairness while leaving room for tension and surprise.",
  },
];

export const directions: Direction[] = [
  {
    id: "tideglass",
    index: "01",
    name: "Tideglass",
    thesis:
      "A drowned world rendered as fragile layers of sea glass and oxidized brass.",
    shape: "Tall, delicate silhouettes interrupted by broad flood lines",
    material: "Salted glass, verdigris, wet stone",
    light: "Cold ambient haze with one warm navigational beam",
    palette: ["#10272c", "#2f7171", "#9fc9bf", "#e3aa65", "#342c2a"],
    artClass: "art-tideglass",
    image: "/m1-prototype/direction-tideglass.png",
  },
  {
    id: "signal-noir",
    index: "02",
    name: "Signal Noir",
    thesis:
      "Graphic coastal horror built from black water, hard light, and impossible shadows.",
    shape: "Bold geometric masses and needle-thin antennae",
    material: "Tar-black water, enamel, brushed aluminum",
    light: "High-contrast cones cut through near-total darkness",
    palette: ["#090b0c", "#232b30", "#e7eee8", "#d8543a", "#65747b"],
    artClass: "art-signal",
    image: "/m1-prototype/direction-signal-noir.png",
  },
  {
    id: "living-ruin",
    index: "03",
    name: "Living Ruin",
    thesis:
      "The flooded town is becoming a luminous reef that remembers its former residents.",
    shape: "Collapsed domestic forms overtaken by branching coral growth",
    material: "Chalky masonry, bioluminescent algae, pale ceramic",
    light: "Soft internal glow blooms beneath storm-muted daylight",
    palette: ["#16251f", "#41705d", "#9ac08f", "#cad8c8", "#a7666a"],
    artClass: "art-ruin",
    image: "/m1-prototype/direction-living-ruin.png",
  },
];

export const concepts = [
  {
    id: "keeper",
    slot: "Hero",
    title: "The Signal Keeper",
    purpose:
      "Establish the playable character's silhouette, equipment, and scale before production begins.",
    revision: "r01",
    note: "Readable coat silhouette, hand-carried tuning fork, warm face plane.",
    artClass: "concept-keeper",
    image: "/m1-prototype/concept-signal-keeper-r01.png",
    revisedImage: "/m1-prototype/concept-signal-keeper-r02.png",
    changeRequest:
      "Make the coat silhouette less bulky and make the brass tuning-fork maintenance tool much easier to read at thumbnail size.",
    state: "review",
  },
  {
    id: "lighthouse",
    slot: "Anchor location",
    title: "The Last Lighthouse",
    purpose:
      "Define the central playable hub, its entrance, and the landmark players navigate toward.",
    revision: "r01",
    note: "Brass ribs carry the approved vertical rhythm into the central landmark.",
    artClass: "concept-lighthouse",
    image: "/m1-prototype/concept-last-lighthouse-r01.png",
    revisedImage: "/m1-prototype/concept-last-lighthouse-r02.png",
    changeRequest:
      "Simplify the lower architecture and make the main playable entrance and approach route unmistakable.",
    state: "review",
  },
  {
    id: "listener",
    slot: "Primary threat",
    title: "The Listener",
    purpose:
      "Define the main threat's readable silhouette and communicate how it hunts without conventional combat.",
    revision: "r01",
    note: "The silhouette reads, but the material language feels too organic for Tideglass.",
    artClass: "concept-listener",
    image: "/m1-prototype/concept-listener-r01.png",
    revisedImage: "/m1-prototype/concept-listener-r02.png",
    changeRequest:
      "Make the sensory crown narrower and less regal, hide the face completely, and make the creature feel like it listens through fragile sea-glass filaments rather than looking through eyes.",
    state: "review",
  },
] as const;

export const projectFacts = [
  "Original pitch preserved",
  "Decisions remain editable",
  "Visual work waits for approval",
  "One direction chosen explicitly",
  "No concept image auto-selected",
];
