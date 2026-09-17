import { vi } from 'vitest';
import { install, repository, runGates } from '../doubles.mjs';

// The setup file of every e2e test: the model, the claude child, the shell and the clock are the real ones. Only git and the gates are
// doubles, so a card can be passed over without a repository to clone; GitHub is whatever client the test hands processCard.
vi.mock('../../src/git.mjs', () => ({ repository: repository }));

vi.mock('../../src/gates.mjs', () => ({ install: install, runGates: runGates }));
