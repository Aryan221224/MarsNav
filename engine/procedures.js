// procedures.js - the checklist a crew member works through at each point of interest (SUITS 2026-27: "procedures per
// point of interest"; NASA-STD-3001 F.6.3 current and completed steps visible). Steps are the team's generic geology
// field procedure [ASSUME], modelled on Perseverance's sampling sequence (abrade, proximity science, core, seal).

export const PROCEDURES = {
  science: ["Arrive: report position, time and walkback margin", "Context imaging: 360 deg panorama",
    "Pick the target outcrop with the science backroom notes", "Clean or abrade a patch", "Close-up imaging and spectra",
    "Collect sample, seal and log the tube ID", "Stow tools, confirm walkback margin, depart"],
  survey: ["Arrive: report position and time", "Landmark photo set for navigation", "Traverse-scale panorama",
    "Note hazards seen (boulders, soft ground, scarps)", "Update map notes, depart"],
  asset: ["Hold the 50 m stand-off", "Photograph the asset", "Report asset status", "Depart"],
  base: [],
};

export function procedureFor(target) {
  if (!target) return PROCEDURES.survey;
  if (Array.isArray(target.procedure)) return target.procedure;
  if (/survey/i.test(target.name || "")) return PROCEDURES.survey;
  return PROCEDURES[target.kind] ?? PROCEDURES.survey;
}
