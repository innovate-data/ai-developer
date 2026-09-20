/*
 * lessons.js - the course content for Cube Clubhouse.
 *
 * Every lesson is plain data so it is easy to translate or tweak. Lessons with
 * a `stage` map to a solver stage: the practice mode sets up a cube that needs
 * exactly that stage, and the hint button asks the solver for the next step.
 *
 * Written for a child of about seven reading with a grown-up: short sentences,
 * every new word explained the first time it is used, and one idea per paragraph.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RC = root.RC || {};
    Object.assign(root.RC, factory());
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // What each move means, in words a child can act on. "The part nearest you" and
  // "rolls up" are things a hand can do; "clockwise" is not, for most seven-year-olds.
  const MOVE_WORDS = {
    U: 'Turn ONLY the top layer to the left. The part nearest you goes left.',
    "U'": 'Turn ONLY the top layer to the right. The part nearest you goes right.',
    U2: 'Turn ONLY the top layer twice, halfway round.',
    D: 'Turn ONLY the bottom layer to the right. The part nearest you goes right.',
    "D'": 'Turn ONLY the bottom layer to the left. The part nearest you goes left.',
    D2: 'Turn ONLY the bottom layer twice, halfway round.',
    R: 'Turn the RIGHT side so it rolls up and away from you.',
    "R'": 'Turn the RIGHT side so it rolls down towards you.',
    R2: 'Turn the RIGHT side twice, halfway round.',
    L: 'Turn the LEFT side so it rolls down towards you.',
    "L'": 'Turn the LEFT side so it rolls up and away from you.',
    L2: 'Turn the LEFT side twice, halfway round.',
    F: 'Turn the FRONT, the side facing you, so its top goes to the right.',
    "F'": 'Turn the FRONT, the side facing you, so its top goes to the left.',
    F2: 'Turn the FRONT twice, halfway round.',
    B: 'Turn the BACK, the side you cannot see, so its top goes to the left.',
    "B'": 'Turn the BACK, the side you cannot see, so its top goes to the right.',
    B2: 'Turn the BACK twice, halfway round.',
    y: 'Turn the WHOLE cube to the left, like a spinning plate. The right side comes to the front.',
    "y'": 'Turn the WHOLE cube to the right, like a spinning plate. The left side comes to the front.',
    y2: 'Turn the WHOLE cube round, so the back faces you.',
    x: 'Roll the WHOLE cube away from you. The front becomes the top.',
    "x'": 'Roll the WHOLE cube towards you. The top becomes the front.',
    x2: 'Flip the WHOLE cube upside down.',
    z: 'Tilt the WHOLE cube to the right, like a steering wheel.',
    "z'": 'Tilt the WHOLE cube to the left, like a steering wheel.',
    z2: 'Tilt the WHOLE cube upside down, like a steering wheel turned halfway.',
  };

  const LESSONS = [
    {
      id: 'meet',
      title: 'Meet Your Cube',
      emoji: '🧊',
      subtitle: 'Middles, edges and corners',
      stage: null,
      interactive: 'parts',
      story: [
        'A cube has 54 stickers. But it is really made of 26 little <b>pieces</b>. There are three kinds. Learn them and you are halfway there!',
        'A <b>centre</b> is the middle square of a side. It has ONE colour. Centres <b>never move</b>. White is always across from yellow. Green is across from blue. Red is across from orange.',
        '<b>Edges</b> have TWO colours. There are 12 of them. An edge sits between two centres. Its two colours are the same as those two centres.',
        '<b>Corners</b> have THREE colours. There are 8 of them. A corner sits where its three colours meet.',
        'A cube is like a sandwich 🥪 with three <b>layers</b>: the top layer, the middle layer and the bottom layer. One layer can turn on its own.',
        'The <b>front</b> is the side facing you. The <b>back</b> is the side you cannot see.',
        'Stickers never come off. Solving means moving each piece to its <b>home</b>. A piece is home when its colours match the centres next to it.',
      ],
      tips: ['Drag the cube with your finger to spin it round and look at every side.', 'Tap the buttons to light up each kind of piece.'],
      algs: [],
    },
    {
      id: 'moves',
      title: 'Cube Talk',
      emoji: '🗣️',
      subtitle: 'The secret letters for every move',
      stage: null,
      interactive: 'notation',
      story: [
        'People who love cubes write moves with letters. Each side has a letter: <b>R</b> for right, <b>L</b> for left, <b>U</b> for up (the top), <b>D</b> for down (the bottom), <b>F</b> for front and <b>B</b> for back.',
        'A plain letter means: look straight at that side and turn it so its top goes to the <b>right</b>. That is the way clock hands go.',
        'A letter with a little tick, like <b>R\'</b>, means turn it the other way. Say "R prime".',
        'A letter with a 2, like <b>U2</b>, means turn it twice. Either way is fine.',
        'Some letters turn the <b>WHOLE cube</b>: <b>y</b> spins it round like a plate, and <b>x</b> rolls it over. Nothing changes. You are just looking at a different side. The app says WHOLE cube when it means that.',
        'Hold the cube still while you do a move. Only one side turns. Tap every button below and watch what happens!',
      ],
      tips: ['R rolls up and away. L rolls down towards you. They go opposite ways.', 'Tap any letter in a trick to hear what it means and watch the cube do it.', 'Play the quiz until you can name any move in a blink.'],
      algs: [],
    },
    {
      id: 'daisy',
      title: 'The Daisy',
      emoji: '🌼',
      subtitle: 'Four white petals around the yellow centre',
      stage: 'daisy',
      story: [
        'Hold the cube with the <b>yellow centre on top</b>. We will make a daisy. The yellow centre is the middle of the flower. Four <b>white edges</b> are the petals around it.',
        'Find an edge with a white sticker. Turn sides to bring it up to the top, white facing up. Any petal can go in any spot.',
        'Got a petal? Keep it safe. Before you turn a side, look up. Is a petal on that side? Turn ONLY the top layer first, to move the petal out of the way.',
        'There is no trick to learn here. It is a puzzle you can work out by looking. Press <b>Hint</b> and the app shows you one petal at a time.',
      ],
      tips: ['White edge on the bottom, white facing down? Turn that side twice. It pops straight up.', 'White edge in the middle layer? One turn of a side brings it to the top.', 'White edge facing sideways? Press Hint. The hint says where it is and what to turn.'],
      algs: [],
    },
    {
      id: 'cross',
      title: 'The White Cross',
      emoji: '➕',
      subtitle: 'Turn the daisy into a cross on the bottom',
      stage: 'cross',
      story: [
        'Every petal has a second colour on its side. Look at one petal. Say its side colour, for example red.',
        'Turn ONLY the top layer until the red sticker sits right above the red centre. Now the petal is lined up.',
        'Turn that side <b>twice</b>. The white sticker travels down to the bottom. The edge is home! The petal has become one arm of the white cross.',
        'Do the same for the other three petals. Then peek at the bottom: a white cross, with every arm matching its centre. Put white back on the bottom.',
      ],
      tips: ['Always line up the side colour BEFORE turning the side down.', 'Turning a side twice never breaks the petals still on top.'],
      algs: [],
    },
    {
      id: 'corners',
      title: 'White Corners',
      emoji: '🔲',
      subtitle: 'Finish the bottom layer with Righty',
      stage: 'corners',
      story: [
        'Keep white on the bottom. Now we fill in the four white corners, so the whole bottom layer is done.',
        'Find a corner on top with a white sticker. Say its other two colours, for example red and green. Its home is on the bottom, between the red centre and the green centre.',
        'Turn the <b>WHOLE cube</b> so that home is at the <b>front-right</b>. Front-right means: nearest you, on your right. Then turn ONLY the top layer, so the corner sits right above its home.',
        'Now do <b>Righty</b>: R U R\' U\'. Say it out loud: "Right up, Top left, Right down, Top right." Peek at the bottom. Is the corner home, white facing down? If not, do Righty again. It takes 1 or 3 goes.',
        'Sometimes a corner would need 5 goes. That is a lot! Instead, do <b>Righty backwards</b>: U R U\' R\'. One backwards Righty does the same job as five forwards. The app tells you when.',
        'A white corner stuck in the bottom in the wrong place? Put it at the front-right and do Righty once. It pops up to the top. Now you can bring it home properly.',
      ],
      tips: ['Grown-up cubers call these tricks <b>algorithms</b>. Same thing, longer word!', 'Righty is the most useful trick in the whole cube. Your right hand does the R moves. Your left hand does the U moves.'],
      algs: [
        { name: 'Righty', moves: "R U R' U'", note: 'Right up, Top left, Right down, Top right. Do it 1 or 3 times.' },
        { name: 'Righty backwards', moves: "U R U' R'", note: 'Instead of five Righties. Same moves, other way round.' },
      ],
    },
    {
      id: 'middle',
      title: 'The Middle Layer',
      emoji: '🥪',
      subtitle: 'Two layers done with the Slide tricks',
      stage: 'middle',
      story: [
        'The bottom layer is done. Now look at the top layer for an edge with <b>no yellow</b> on it. That edge belongs in the middle layer.',
        'Turn ONLY the top layer, until the side sticker of that edge is right above the centre of the same colour. It makes an upside-down T. Turn the WHOLE cube so that T faces you.',
        'Look at the sticker on TOP of that edge. Say its colour. Find the centre with that colour. Is it on your <b>right</b>? Do the <b>Slide-right trick</b>. Is it on your <b>left</b>? Do the <b>Slide-left trick</b>. The edge slides down into its place.',
        'Do this for all four middle edges. Sometimes every edge on top has yellow, but the middle layer is still wrong. Then put the wrong edge at the front-right and do the Slide-right trick. It pops out to the top.',
      ],
      tips: ['Slide-right starts by turning the top AWAY from the right side (U). Slide-left starts by turning the top away from the left (U\').', 'Both tricks are two little pieces joined up: an R part and an F part.'],
      algs: [
        { name: 'Slide-right trick', moves: "U R U' R' U' F' U F", note: 'Top colour matches the centre on the RIGHT.' },
        { name: 'Slide-left trick', moves: "U' L' U L U F U' F'", note: 'Top colour matches the centre on the LEFT.' },
      ],
    },
    {
      id: 'ycross',
      title: 'The Yellow Cross',
      emoji: '✨',
      subtitle: 'Make a plus sign on top',
      stage: 'ycross',
      story: [
        'Two layers done! Now only the yellow stickers on <b>top</b> matter. Do not worry about the side colours yet.',
        'Look at the top. Count the yellow edges. You will see one of these shapes:',
        '<b>DOT</b>: no yellow edges. <b>L</b>: two yellow edges next to each other. <b>LINE</b>: two yellow edges across from each other. <b>CROSS</b>: all four. Done!',
        'Got an L? Turn ONLY the top layer, so one yellow edge is at the BACK and one is on the LEFT. Got a line? Turn ONLY the top layer so it goes from left to right. Then do the <b>Cross trick</b>.',
        'A dot becomes an L. An L becomes a line. A line becomes a cross. So you may do the trick up to three times. Check the shape each time.',
      ],
      tips: ['The Cross trick is Righty with an F at the start and an F\' at the end: F, Righty, F\'.', 'The bottom will look messy in the middle of the trick. Finish it and it comes back!'],
      algs: [{ name: 'Cross trick', moves: "F R U R' U' F'", note: 'F, then Righty, then F\'.' }],
    },
    {
      id: 'yedges',
      title: 'Yellow Edges Home',
      emoji: '🧭',
      subtitle: 'Line up the sides of the cross',
      stage: 'yedges',
      story: [
        'You have a yellow cross. But the side colours of the yellow edges probably do not match the centres. Turn ONLY the top layer. Stop when the most edges match. You will get 2 or 4.',
        'All four match? You are done! Only two match? Stop turning the top. Another turn would only break them.',
        'Instead, turn the <b>WHOLE cube</b> so those two matching edges are at the <b>back</b> and on the <b>right</b>. Now do the <b>Edge trick</b>. It swaps the front edge with the left edge. The back and right edges stay put. So all four end up matching.',
        'Are the two matching edges across from each other? Then do the Edge trick once, from anywhere. Now two matching edges are next to each other. Do the step above.',
      ],
      tips: ['The Edge trick goes like a wave: R U R\' U, then R U2 R\', then one more U.', 'Turning the TOP picks how many edges match. Turning the WHOLE cube keeps them matching while you aim them at the back and the right.'],
      algs: [{ name: 'Edge trick', moves: "R U R' U R U2 R' U", note: 'Swaps the front and left yellow edges.' }],
    },
    {
      id: 'ycorners',
      title: 'Yellow Corners Home',
      emoji: '🏠',
      subtitle: 'Move corners to the right spot (twisted is fine)',
      stage: 'ycorners',
      story: [
        'Look at a yellow corner. Look at the 3 centres next to it. Same 3 colours? Then the corner is <b>home</b>. In this lesson, home means the right spot. A home corner can still be <b>twisted</b>: its yellow sticker faces sideways instead of up. That is fine for now.',
        'Find a corner that is home. Turn the WHOLE cube so that corner is at the front-right. Do the <b>Corner trick</b>. The front-right corner stays. The other three move round.',
        'Check again. Not all home yet? Keep the same corner at the front-right and do the Corner trick once more.',
        'No corner is home at the start? Do the Corner trick once from anywhere. Then one corner will be home.',
      ],
      tips: ['Say the Corner trick in pairs: "U R, U\' L\', U R\', U\' L".', 'Watch out for the last move: it is a plain L.'],
      algs: [{ name: 'Corner trick', moves: "U R U' L' U R' U' L", note: 'Front-right corner stays. The other three move round.' }],
    },
    {
      id: 'ytwist',
      title: 'The Grand Finale',
      emoji: '🏆',
      subtitle: 'Twist the last corners and celebrate',
      stage: 'ytwist',
      story: [
        'All the corners are home. Some are twisted, so their yellow sticker faces sideways. One more trick and you are done.',
        'Turn ONLY the top layer, so a twisted corner is at the <b>front-right</b>. Do the <b>Twist trick</b> R\' D\' R D twice. Then check. Yellow not on top yet? Do it twice more.',
        'Four twists is a lot. Instead, do the <b>Twist trick backwards</b>: D\' R\' D R, twice. That does the same job as four forwards. The app tells you which one to use.',
        'The bottom will look messy. That is normal! Keep going. Do NOT turn the whole cube.',
        'Yellow on top? Good. Turn ONLY the top layer to bring the next twisted corner to the front-right. Do the Twist trick again. All corners yellow? Turn ONLY the top layer to line it up. You did it!',
      ],
      tips: ['Count your twists: it is always 2 forwards or 2 backwards for one corner.', 'Keep your right hand ready: the Twist trick uses only the right side and the bottom.'],
      algs: [
        { name: 'Twist trick', moves: "R' D' R D", note: 'Twice per corner. Only the top layer turns between corners.' },
        { name: 'Twist trick backwards', moves: "D' R' D R", note: 'Twice, instead of four forwards.' },
      ],
    },
  ];

  const STAGE_TITLES = {
    orient: 'Hold it correctly',
    centres: 'Centres',
    edges: 'Pair the edges',
    parity: 'Big-cube fix',
    daisy: 'Daisy',
    cross: 'White cross',
    corners: 'White corners',
    middle: 'Middle layer',
    ycross: 'Yellow cross',
    yedges: 'Yellow edges',
    ycorners: 'Yellow corners',
    ytwist: 'Twist the corners',
    finish: 'Finish',
  };

  return { LESSONS, MOVE_WORDS, STAGE_TITLES };
});
