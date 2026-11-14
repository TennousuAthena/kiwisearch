export type DomainPreferenceAction = 'block' | 'boost' | 'clear';
export interface DomainPreferenceState { blocked: boolean; boosted: boolean }
export interface DomainPreferenceUndo { domain: string; before: DomainPreferenceState; after: DomainPreferenceState; revision: string }
