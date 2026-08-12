// Structured per-category spec field definitions. Each field is an object
// (not just a key) so per-field select options can be layered on later
// (e.g. `options: string[]`) without reworking the forms again.
export type SpecFieldDef = {
  key: string;
  label: string;
  /** Reserved for future per-field dropdown options. */
  options?: string[];
};

const f = (key: string, label: string): SpecFieldDef => ({ key, label });

export const WINDOW_FIELDS: SpecFieldDef[] = [
  f("brand", "Brand"),
  f("series", "Series"),
  f("exteriorColor", "Exterior Color"),
  f("interiorColor", "Interior Color"),
  f("jambDepth", "Jamb Depth"),
  f("dividedLites", "Divided Lites"),
  f("hardwareFinish", "Hardware Finish"),
  f("screenColor", "Screen Color"),
];

// Interior doors use a reduced set: no Exterior Color, Interior Finish, or
// Glass/Lite Options. Old quotes may still carry values for those removed
// fields — they are preserved on save and shown read-only, never deleted.
export const INTERIOR_DOOR_FIELDS: SpecFieldDef[] = [
  f("brand", "Brand"),
  f("seriesStyle", "Series/Style"),
  f("materialSpecies", "Material/Species"),
  f("jambDepth", "Jamb Depth"),
  f("hardwareFinish", "Hardware Finish"),
];

export const EXTERIOR_DOOR_FIELDS: SpecFieldDef[] = [
  f("brand", "Brand"),
  f("seriesStyle", "Series/Style"),
  f("materialSpecies", "Material/Species"),
  f("exteriorColor", "Exterior Color"),
  f("interiorFinish", "Interior Finish"),
  f("jambDepth", "Jamb Depth"),
  f("hardwareFinish", "Hardware Finish"),
  f("glassLiteOptions", "Glass/Lite Options"),
  f("lockPrep", "Lock Prep"),
];

// Legacy pre-split "Doors" quotes keep the original full field set.
export const LEGACY_DOOR_FIELDS: SpecFieldDef[] = [
  f("brand", "Brand"),
  f("seriesStyle", "Series/Style"),
  f("materialSpecies", "Material/Species"),
  f("exteriorColor", "Exterior Color"),
  f("interiorFinish", "Interior Finish"),
  f("jambDepth", "Jamb Depth"),
  f("hardwareFinish", "Hardware Finish"),
  f("glassLiteOptions", "Glass/Lite Options"),
];

// Labels for read-only display of legacy interior-door values that are no
// longer editable fields on the interior door form.
export const REMOVED_INTERIOR_DOOR_FIELDS: SpecFieldDef[] = [
  f("exteriorColor", "Exterior Color"),
  f("interiorFinish", "Interior Finish"),
  f("glassLiteOptions", "Glass/Lite Options"),
];
