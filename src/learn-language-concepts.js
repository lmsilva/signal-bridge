/**
 * Shared A1/A2 concept table for the European Learn {Language} boards.
 *
 * Each row is [id, english, pos, level, portuguese, spanish, french, german, italian].
 * Portuguese leans European (autocarro, comboio, sumo). Lives in `src/` so
 * the Docker image (which copies `src`, not `tools`) can load it.
 */

module.exports = require('../tools/learn-language-concepts');
