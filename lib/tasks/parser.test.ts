import { describe, it, expect } from 'vitest';

// Test the regex patterns extracted from parser.ts (pure, no I/O)
const taskRegex = /^(\s*)-\s+\[([ \/xX])\]\s+(.*)$/;
const idRegex = /<!--\s*id:\s*([a-zA-Z0-9-]+)\s*-->$/;
const priorityRegex = /(🔴|🟡|🔵|🟢)/;
const dueDateRegex = /@due\(([^)]+)\)/;

describe('Task line regex', () => {
    it('matches a basic TODO', () => {
        const m = taskRegex.exec('- [ ] Buy milk');
        expect(m).not.toBeNull();
        expect(m![2]).toBe(' ');
        expect(m![3]).toBe('Buy milk');
    });

    it('matches IN_PROGRESS', () => {
        const m = taskRegex.exec('- [/] In flight task');
        expect(m![2]).toBe('/');
    });

    it('matches DONE with x', () => {
        const m = taskRegex.exec('- [x] Done thing');
        expect(m![2]).toBe('x');
    });

    it('matches DONE with X', () => {
        const m = taskRegex.exec('- [X] Done thing');
        expect(m![2]).toBe('X');
    });

    it('captures indentation', () => {
        const m = taskRegex.exec('  - [ ] Indented child');
        expect(m![1]).toBe('  ');
    });

    it('does not match non-task lines', () => {
        expect(taskRegex.exec('# Heading')).toBeNull();
        expect(taskRegex.exec('Regular text')).toBeNull();
        expect(taskRegex.exec('')).toBeNull();
    });
});

describe('ID injection regex', () => {
    it('extracts an existing id', () => {
        const m = idRegex.exec('Do something <!-- id: abc-123 -->');
        expect(m![1]).toBe('abc-123');
    });

    it('returns null when no id', () => {
        expect(idRegex.exec('Do something')).toBeNull();
    });

    it('handles UUID-format id', () => {
        const m = idRegex.exec('Task text <!-- id: 550e8400-e29b-41d4-a716-446655440000 -->');
        expect(m![1]).toBe('550e8400-e29b-41d4-a716-446655440000');
    });
});

describe('Priority emoji regex', () => {
    it('detects BLOCKER (red)', () => expect(priorityRegex.exec('🔴 Critical task')![1]).toBe('🔴'));
    it('detects HIGH (yellow)', () => expect(priorityRegex.exec('🟡 Important')![1]).toBe('🟡'));
    it('detects MEDIUM (blue)', () => expect(priorityRegex.exec('🔵 Normal')![1]).toBe('🔵'));
    it('detects LOW (green)', () => expect(priorityRegex.exec('🟢 Backlog')![1]).toBe('🟢'));
    it('returns null for plain text', () => expect(priorityRegex.exec('No emoji')).toBeNull());
});

describe('Due date regex', () => {
    it('extracts a date', () => {
        const m = dueDateRegex.exec('Task @due(2026-12-31)');
        expect(m![1]).toBe('2026-12-31');
    });

    it('returns null when no @due', () => {
        expect(dueDateRegex.exec('Task without due')).toBeNull();
    });
});
