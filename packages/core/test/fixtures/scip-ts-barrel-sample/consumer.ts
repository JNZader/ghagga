// Imports greet via the barrel (index.ts), not directly from impl.ts —
// this is the shape that regresses blast-radius without the D1/D2 fix.
import { greet } from './index';

console.log(greet('ghagga'));
