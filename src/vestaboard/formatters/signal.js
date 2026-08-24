// Frames about the bridge itself rather than about the house (03 §E).

const { COLS, blankRow } = require('../encoder');
const { badgeFrame, chipCode, BODY_TO } = require('../frames');

// One pass of every colour, twice, as a mechanical self-check: if a flap is
// stuck or a colour is missing you can see it from across the room.
const CHIP_PARADE = ['red', 'orange', 'yellow', 'green', 'blue', 'violet', 'white'];
const PARADE_LEFT_FROM = 1;
const PARADE_RIGHT_FROM = 12;

/** A long board name would run past the row, so it is cut to what fits. */
function fitBoardName(name) {
  const room = BODY_TO - 2 + 1 - ' - OK'.length;
  return String(name || 'VESTABOARD').slice(0, room);
}

function paradeRow() {
  const row = blankRow(COLS);
  CHIP_PARADE.forEach((colour, index) => {
    row[PARADE_LEFT_FROM + index] = chipCode(colour);
    row[PARADE_RIGHT_FROM + index] = chipCode(colour);
  });
  return row;
}

/**
 * The Test flip frame: proof that a board is reachable, that its key works,
 * and that every colour of flap still turns.
 */
function identityFrame({ name = 'VESTABOARD' } = {}) {
  const layout = badgeFrame({
    color: 'white',
    title: 'SIGNAL BRIDGE',
    rows: [
      '',
      { left: 'VESTABOARD LINKED', from: 2 },
      { left: `${fitBoardName(name)} - OK`, from: 2, to: BODY_TO },
      '',
    ],
  });

  layout[layout.length - 1] = paradeRow();
  return {
    rows: layout,
    dwellSeconds: 15,
    label: 'Test flip',
    source: 'signal.identity',
  };
}

module.exports = {
  identityFrame,
  paradeRow,
  fitBoardName,
  CHIP_PARADE,
};
