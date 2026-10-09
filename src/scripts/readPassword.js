const readline = require('readline');

/**
 * Gets a password for an operator script without putting it on the command
 * line, where it lands in shell history and in every process listing.
 *
 * Order: the ADMIN_PASSWORD environment variable, then a prompt whose typing is
 * not echoed. A password still passed as an argument works, with a warning, so
 * existing runbooks do not break.
 */
const readPassword = async (argvValue, prompt = 'Password: ') => {
  if (argvValue) {
    console.warn('Warning: a password on the command line is saved in shell history. Omit it to be prompted instead.');
    return argvValue;
  }
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Swallow echo: print only the prompt, never what is typed.
  rl._writeToOutput = (text) => {
    if (text.includes(prompt)) rl.output.write(prompt);
  };
  const answer = await new Promise((resolve) => rl.question(prompt, resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
};

const MIN_PASSWORD_LENGTH = 8;

module.exports = { readPassword, MIN_PASSWORD_LENGTH };
