// Bullet shape — stored as a JSON array inside WorkRole.bullets, Project.bullets,
// and Education.bullets. Each bullet has a stable id so the UI can lock/exclude
// and the resume-generation pipeline can cite "why this bullet was selected"
// (see §8 stories 34–36).
export interface Bullet {
    id: string;
    text: string;
    tags: string[];
    locked: boolean;
    excluded: boolean;
}
