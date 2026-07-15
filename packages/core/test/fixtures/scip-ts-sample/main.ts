// Entry point fixture. Imports greet from pkg/greeting by its module path
// (relative import), and calls the exported symbol.
import { greet } from './pkg/greeting';

console.log(greet('ghagga'));
