export type StudioRoute = "m0" | "m1" | "m1-prototype";

export const resolveStudioRoute = (search: string): StudioRoute => {
  const params = new URLSearchParams(search);
  if (params.get("prototype") === "m1") return "m1-prototype";
  return params.get("studio") === "m0" ? "m0" : "m1";
};
