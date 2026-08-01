// A tiny playground program for trying the OpenCode Chat agent.
//
// Open the LM Studio panel and ask things like:
//   • "explain what app.js does"
//   • "add a reverseString(s) function and call it in main"
//   • "write a quick test for fib() and run it"
//   • "refactor main() to print a table"

function greet(name) {
  return `Hello, ${name}!`;
}

// Naive recursive Fibonacci — great for asking the agent to memoize/optimize.
function fib(n) {
  if (n < 2) {
    return n;
  }
  return fib(n - 1) + fib(n - 2);
}

// Memoized Fibonacci used to render the spiral fast.
function fibMemo(n) {
  const memo = [0, 1];
  for (let i = 2; i <= n; i++) {
    memo[i] = memo[i - 1] + memo[i - 2];
  }
  return memo[n];
}

// ANSI color helpers (plain escape sequences — no dependencies).
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function banner() {
  return (
    `${GREEN}` +
    '   ____                __ _       \n' +
    '  / __/__  ___  __ __ / /(_)  __  \n' +
    ' / _// _ \\/ -_)/ // // // / |/ /  \n' +
    '/___/_//_/\\__/___/_,_/_//_/|___/  \n' +
    `${RESET}`
  );
}

// Draw a Fibonacci spiral on a text grid, turning 90 degrees at each
// Fibonacci-numbered segment length.
function drawFibonacciSpiral(steps = 8) {
  const cols = 80;
  const rows = 40;
  const grid = Array.from({ length: rows }, () => Array(cols).fill(' '));

  let x = Math.floor(cols / 2);
  let y = Math.floor(rows / 2);

  // Right, up, left, down — quarter turn each step.
  const dirs = [
    [1, 0],
    [0, -1],
    [-1, 0],
    [0, 1]
  ];
  let dir = 0;

  for (let i = 1; i <= steps; i++) {
    const len = fibMemo(i);
    const [dx, dy] = dirs[dir];
    for (let s = 0; s < len; s++) {
      if (x >= 0 && x < cols && y >= 0 && y < rows) {
        grid[y][x] = '#';
      }
      x += dx;
      y += dy;
    }
    dir = (dir + 1) % 4;
  }

  return grid.map((row) => `${GREEN}${row.join('')}${RESET}`).join('\n');
}

// As n grows, fib(n+1)/fib(n) approaches the golden ratio.
function goldenRatio(precision = 12) {
  let a = 0;
  let b = 1;
  for (let i = 2; i <= precision; i++) {
    [a, b] = [b, a + b];
  }
  return b / a;
}

function main() {
  console.log(banner());
  for (const name of ['Ada', 'Alan', 'Grace']) {
    console.log(greet(name));
  }
  for (let i = 0; i < 8; i++) {
    console.log(`fib(${i}) = ${fib(i)}`);
  }
  console.log();
  console.log(`${YELLOW}Fibonacci spiral:${RESET}`);
  console.log(drawFibonacciSpiral(10));
  console.log();
  console.log(`Golden ratio ≈ ${YELLOW}${goldenRatio(30).toFixed(10)}${RESET}`);
}

main();
