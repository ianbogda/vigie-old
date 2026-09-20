export type OpaleSourceId = 'YBALAC' | 'YBALAF' | 'EBLC' | 'YFDR' | 'YGPIE1';
export type OpaleGuideStep = {
  n: string;
  title: string;
  description: string;
  image?: string;
};

export type OpaleSourceHelp = {
  id: OpaleSourceId;
  label: string;
  format: string;
  variant?: string;
  tutorialAvailable: boolean;
  steps: OpaleGuideStep[];
  beforeImport?: string;
};

export type HelpFormula = { numerator?: string; denominator?: string; expression?: string; suffix?: string };
export type HelpIndicator = {
  name: string;
  short?: string;
  meaning: string;
  formula?: HelpFormula;
  reading?: string;
  caution?: string;
  source?: string;
};

import type { IndicatorId } from './indicators';

export type ViewHelpSpec = {
  purpose: string;
  sources: Array<OpaleSourceId | { name: string; format: string; note?: string }>;
  notes?: string[];
  indicators?: IndicatorId[];
};
