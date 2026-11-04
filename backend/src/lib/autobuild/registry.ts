import { detectFullstack, detectNode, detectPython, detectStatic } from './detect';
import { render } from './render';
import { BuildStrategy } from './types';

// First match wins. A future BuildpackStrategy implements detect/render and can
// join this registry without changing the worker, limits, or deployment runner.
export const strategies: BuildStrategy[] = [
  { id: 'fullstack', detect: detectFullstack, render },
  { id: 'node', detect: detectNode, render },
  { id: 'python', detect: detectPython, render },
  { id: 'static', detect: detectStatic, render },
];
