/**
 * The emoji people react and write with (F19.4): about three hundred of
 * Unicode's own, in the groups Unicode orders them in. Characters, not
 * pictures, so each is drawn by the reader's own system font and nothing is
 * fetched; a list rather than a dependency, since a picker needs no more.
 */
import { N } from '../i18n.ts';

/** The ones offered first under a message: the reactions people use most. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '🙏', '👀', '✅'] as const;

/** Each group's name, drawn through `t()`, and its emoji. */
export const EMOJI_GROUPS: ReadonlyArray<{ name: string; emoji: readonly string[] }> = [
  {
    name: N('Smileys'),
    emoji: [...'😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍🤩😘😗😚😙😋😛😜🤪😝🤑🤗🤭🤫🤔🤐🤨😐😑😶😏😒🙄😬😮‍💨🤥😌😔😪🤤😴😷🤒🤕🤢🤮🥵🥶🥴😵🤯🤠🥳😎🤓🧐😕😟🙁😮😯😲😳🥺😦😧😨😰😥😢😭😱😖😣😞😓😩😫🥱😤😡😠🤬']
      .reduce<string[]>(joinZwj, []),
  },
  {
    name: N('People'),
    emoji: [...'👋🤚🖐✋🖖👌🤌🤏✌🤞🤟🤘🤙👈👉👆👇☝👍👎✊👊🤛🤜👏🙌👐🤲🤝🙏✍💅🤳💪🧠👀👁👅👄👶🧒👦👧🧑👱👨🧔👩🧓👴👵🙍🙎🙅🙆💁🙋🧏🙇🤦🤷']
      .reduce<string[]>(joinZwj, []),
  },
  {
    name: N('Nature'),
    emoji: [...'🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🐔🐧🐦🐤🦆🦅🦉🐺🐗🐴🦄🐝🐛🦋🐌🐞🐢🐍🐙🦀🐠🐟🐬🐳🌵🎄🌲🌳🌴🌱🌿🍀🍁🍂🌷🌹🌺🌸🌼🌻🌞🌝🌙⭐🌟✨⚡🔥🌈☀⛅☁🌧⛈❄💧🌊']
      .reduce<string[]>(joinZwj, []),
  },
  {
    name: N('Food'),
    emoji: [...'🍏🍎🍐🍊🍋🍌🍉🍇🍓🫐🍈🍒🍑🥭🍍🥥🥝🍅🥑🥦🌶🌽🥕🥔🍠🥐🍞🧀🥚🍳🥞🥓🍗🍖🌭🍔🍟🍕🥪🌮🍝🍜🍲🍛🍣🍱🥟🍤🍙🍚🍘🍢🍡🍧🍨🍦🥧🧁🍰🎂🍮🍭🍬🍫🍿🍩🍪☕🍵🧃🥤🧋🍺🍷🥂']
      .reduce<string[]>(joinZwj, []),
  },
  {
    name: N('Activities'),
    emoji: [...'⚽🏀🏈⚾🎾🏐🏉🎱🏓🏸🥅⛳🏹🎣🥊🎽🛹⛸🏆🥇🥈🥉🏅🎖🎗🎫🎟🎪🎭🎨🎬🎤🎧🎼🎹🥁🎷🎺🎸🎻🎲♟🎯🎳🎮🧩']
      .reduce<string[]>(joinZwj, []),
  },
  {
    name: N('Travel'),
    emoji: [...'🚗🚕🚙🚌🏎🚓🚑🚒🚚🚛🚜🛵🏍🚲🛴🚨🚆🚇✈🛫🛬🚀🛸🚁⛵🚤🚢⚓🗺🏠🏡🏢🏬🏭🏪🏫🏥🏦🏨⛪🕌🗼🗽⛲🌋🏖🏝🏜🌅🌄🌇🌃🌉']
      .reduce<string[]>(joinZwj, []),
  },
  {
    name: N('Objects'),
    emoji: [...'⌚📱💻⌨🖥🖨🖱💽💾💿📷📹🎥📞☎📺📻⏰⌛⏳📡🔋🔌💡🔦🕯🧯💸💵💴💶💷💰💳💎⚖🧰🔧🔨🛠⛏🔩⚙🧱⛓🧲🔫💣🔪🗡🛡🔮💈🧪🌡🧹🧺🧻🚽🛁🔑🗝🚪🛋🛏🧸🖼🛍🛒🎁🎈🎉🎊✉📩📨📧📦📫📪📬📭📮📝📄📃📑📊📈📉📆📅🗓📇🗃🗳🗄📋📁📂🗂📰📓📔📒📕📗📘📙📚📖🔖🔗📎🖇📐📏📌📍✂🖊🖋✒🖌🖍✏🔍🔎🔒🔓']
      .reduce<string[]>(joinZwj, []),
  },
  {
    name: N('Symbols'),
    emoji: [...'❤🧡💛💚💙💜🖤🤍🤎💔❣💕💞💓💗💖💘💝✅☑✔❌❎➕➖➗✖💯💢💥💫💦💨🕳💬💭🗯♻⚠🚫⛔📛🔰⭕✳❇❓❔❗❕‼⁉🔴🟠🟡🟢🔵🟣⚫⚪🟥🟧🟨🟩🟦🟪⬛⬜🔶🔷🔸🔹🔺🔻💠🔘🔲🔳🏁🚩🎌🏴🏳']
      .reduce<string[]>(joinZwj, []),
  },
];

/**
 * Spreading a string splits it into code points, which parts a character
 * built with a zero-width joiner (😮‍💨) and drops the variation selector
 * some symbols are drawn as pictures with. The joiner, the selector and
 * what follows a joiner are put back on the character they belong to.
 */
function joinZwj(all: string[], point: string): string[] {
  const last = all.at(-1);
  if (last !== undefined && (point === '‍' || point === '️' || last.endsWith('‍'))) {
    all[all.length - 1] = last + point;
  } else {
    all.push(point);
  }
  return all;
}
