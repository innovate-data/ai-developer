/*
 * lessons.js - the course content for Cube Buddy.
 *
 * Every lesson is plain data so it is easy to translate or tweak. Lessons with
 * a `stage` map to a solver stage: the practice mode sets up a cube that needs
 * exactly that stage, and the hint button asks the solver for the next step.
 */
(function (root) {
  'use strict';

  const MOVE_WORDS = {
    U: 'Turn the TOP layer to the left',
    "U'": 'Turn the TOP layer to the right',
    U2: 'Turn the TOP layer twice',
    D: 'Turn the BOTTOM layer to the right',
    "D'": 'Turn the BOTTOM layer to the left',
    D2: 'Turn the BOTTOM layer twice',
    R: 'Turn the RIGHT side up, away from you',
    "R'": 'Turn the RIGHT side down, toward you',
    R2: 'Turn the RIGHT side twice',
    L: 'Turn the LEFT side down, toward you',
    "L'": 'Turn the LEFT side up, away from you',
    L2: 'Turn the LEFT side twice',
    F: 'Turn the FRONT like a clock (clockwise)',
    "F'": 'Turn the FRONT backwards (counter-clockwise)',
    F2: 'Turn the FRONT twice',
    B: 'Turn the BACK clockwise, as if you were looking at the back',
    "B'": 'Turn the BACK counter-clockwise, as if you were looking at the back',
    B2: 'Turn the BACK twice',
    y: 'Turn the WHOLE cube to the left, so the right side faces you',
    "y'": 'Turn the WHOLE cube to the right, so the left side faces you',
    y2: 'Turn the WHOLE cube around, so the back faces you',
    x: 'Roll the WHOLE cube up: the front becomes the top',
    "x'": 'Roll the WHOLE cube down: the top becomes the front',
    x2: 'Flip the WHOLE cube upside down',
    z: 'Tilt the WHOLE cube clockwise, like a steering wheel',
    "z'": 'Tilt the WHOLE cube counter-clockwise',
    z2: 'Tilt the WHOLE cube upside down, like a steering wheel',
  };

  const LESSONS = [
    {
      id: 'meet',
      title: 'Meet Your Cube',
      emoji: '🧊',
      subtitle: 'Centres, edges and corners',
      stage: null,
      interactive: 'parts',
      story: [
        'A Rubik\'s Cube looks like it has 54 stickers, but it is really made of 26 little blocks. Learn the three kinds and you are already halfway to solving it!',
        '<b>Centres</b> are the middle square of each side. They have ONE colour and they <b>never move</b>. The white centre is always opposite the yellow one, green is opposite blue, and red is opposite orange.',
        '<b>Edges</b> have TWO colours. There are 12 of them. An edge lives between two centres that match its colours.',
        '<b>Corners</b> have THREE colours. There are 8 of them. A corner lives where its three colours meet.',
        'When we "solve" the cube, we are not moving stickers around. We are moving whole blocks to the home spot where their colours match the centres.',
      ],
      tips: ['Drag the cube with your finger or mouse to spin it around and look at every side.', 'Tap the buttons to light up each kind of block.'],
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
        'Cubers write moves with letters so they can share tricks. Each side has a letter: <b>R</b>ight, <b>L</b>eft, <b>U</b>p (the top), <b>D</b>own (the bottom), <b>F</b>ront and <b>B</b>ack.',
        'A letter by itself means: turn that side <b>clockwise</b>, as if you were looking straight at that side. Think of turning a doorknob.',
        'A letter with a little tick, like <b>R\'</b> (say "R prime"), means turn it the other way: counter-clockwise.',
        'A letter with a 2, like <b>U2</b>, means turn it twice. Two turns is a half turn, so the direction does not matter.',
        'Hold the cube still while you do the moves. Only one side turns at a time. Try every button below and watch what happens!',
      ],
      tips: ['R goes UP and away from you, L goes DOWN toward you. They look like mirror images.', 'Play the quiz until you can name any move in a blink.'],
      algs: [],
    },
    {
      id: 'daisy',
      title: 'The Daisy',
      emoji: '🌼',
      subtitle: 'Four white petals around the yellow centre',
      stage: 'daisy',
      story: [
        'Hold the cube with the <b>yellow centre on top</b>. We are going to make a daisy: the yellow centre is the middle of the flower and four <b>white edges</b> are the petals around it.',
        'Find an edge with a white sticker. Turn sides to bring it up to the top so the white faces up. It does not matter which petal goes where yet.',
        'Careful! Once a petal is in place, try not to knock it back out when you bring the next one up. If a side turn would ruin a petal, first turn the top layer to move that petal out of the way.',
        'This step has no algorithm to memorise. It is a puzzle you can figure out by looking, and it is great practice for seeing how the pieces move.',
      ],
      tips: ['If a white edge is in the bottom layer with white facing down, turn its side twice (like F2) and it pops straight up.', 'If a white edge is in the middle layer, one turn of a side brings it to the top.', 'Stuck? Press Hint. The Buddy will show you one petal at a time.'],
      algs: [],
    },
    {
      id: 'cross',
      title: 'The White Cross',
      emoji: '➕',
      subtitle: 'Turn the daisy into a cross on the bottom',
      stage: 'cross',
      story: [
        'Every petal has a second colour on its side. Look at one petal and its side colour, for example red.',
        'Turn <b>only the top layer</b> until the red sticker sits right on top of the red centre. Now the petal is lined up.',
        'Turn that side <b>twice</b>. The white sticker travels down to the bottom and the edge is home! The petal turns into a leg of the white cross.',
        'Do the same for the other three petals. When you are done, flip the cube over: there is a white cross with every side colour matching its centre.',
      ],
      tips: ['Always match the side colour BEFORE turning the side down.', 'Turning a side twice never breaks the petals that are still on top.'],
      algs: [],
    },
    {
      id: 'corners',
      title: 'White Corners',
      emoji: '🔲',
      subtitle: 'Finish the first layer with "Righty"',
      stage: 'corners',
      story: [
        'Keep white on the bottom. Now we fill in the four white corners so the whole bottom layer is finished.',
        'Find a corner with a white sticker in the <b>top layer</b>. Look at its other two colours. Its home is the bottom corner between those two centres.',
        'Turn the whole cube so that home spot is at the <b>front-right</b>. Then turn the top layer so the corner sits right above its home.',
        'Now do <b>Righty</b>: R U R\' U\'. Check the corner. Is it home with white on the bottom? If not, do Righty again. It never takes more than five Rightys.',
        'If a white corner is stuck in the bottom layer in the wrong spot, put it at the front-right and do Righty once. It pops up to the top, and now you can bring it home properly.',
      ],
      tips: ['Righty is the most useful trick in the whole cube. Say it out loud: "Right up, Top left, Right down, Top right."', 'Your right hand does the R moves and your left hand does the U moves. Fast cubers do this without looking!'],
      algs: [{ name: 'Righty', moves: "R U R' U'", note: 'Repeat until the corner is home.' }],
    },
    {
      id: 'middle',
      title: 'The Middle Layer',
      emoji: '🥪',
      subtitle: 'Two layers done with the Right and Left tricks',
      stage: 'middle',
      story: [
        'The bottom layer is finished. Now look at the top layer for an edge that has <b>no yellow</b> on it. That edge belongs in the middle layer.',
        'Turn the top layer until the side colour of that edge matches the centre below it. It makes an upside-down T shape. Turn the whole cube so that T faces you.',
        'Now look at the TOP sticker of the edge. If that colour is on your <b>right</b>, do the <b>Right trick</b>. If it is on your <b>left</b>, do the <b>Left trick</b>. The edge slides down into its slot.',
        'Repeat for all four middle edges. If every edge on top has yellow but a middle edge is in the wrong slot, put that slot at the front-right and do the Right trick to pop the wrong edge out.',
      ],
      tips: ['The Right trick starts by turning the top AWAY from the right side (U), the Left trick starts by turning the top away from the left (U\').', 'Both tricks are just two Righty-style moves put together: an R part and an F part.'],
      algs: [
        { name: 'Right trick', moves: "U R U' R' U' F' U F", note: 'Top colour matches the RIGHT centre.' },
        { name: 'Left trick', moves: "U' L' U L U F U' F'", note: 'Top colour matches the LEFT centre.' },
      ],
    },
    {
      id: 'ycross',
      title: 'The Yellow Cross',
      emoji: '✨',
      subtitle: 'Make a plus sign on top',
      stage: 'ycross',
      story: [
        'Two layers done! Now we only care about the yellow stickers on <b>top</b>. Do not worry about the side colours yet.',
        'Look at the top and find the yellow edges. You will see a <b>dot</b> (no yellow edges), an <b>L shape</b> (two yellow edges next to each other), a <b>line</b> (two yellow edges opposite), or the finished <b>cross</b>.',
        'For an L: turn the top so the L points to the back and to the left (like 9 o\'clock and 12 o\'clock). For a line: turn the top so it goes from left to right. Then do the <b>Cross trick</b>.',
        'A dot becomes an L, an L becomes a line, a line becomes a cross. So you might need to do the trick up to three times, checking the shape each time.',
      ],
      tips: ['The Cross trick is Righty with an F at the start and an F\' at the end: F, Righty, F\'.', 'Your bottom two layers will look messy in the middle of the trick. Finish it and they come back!'],
      algs: [{ name: 'Cross trick', moves: "F R U R' U' F'", note: 'F, then Righty, then F\'.' }],
    },
    {
      id: 'yedges',
      title: 'Yellow Edges Home',
      emoji: '🧭',
      subtitle: 'Line up the sides of the cross',
      stage: 'yedges',
      story: [
        'You have a yellow cross, but the side colours of the yellow edges probably do not match the centres. Turn the top layer and see how many edges you can make match at once.',
        'If all four match, you are done with this step! If only two match, turn the top so the matching edges are at the <b>back and the right</b>.',
        'Now do the <b>Edge trick</b>. It swaps the edge at the front with the edge at the left. Then check again.',
        'If the two matching edges are opposite each other (front and back), do the Edge trick once, and then two edges next to each other will match. Line them up at back and right and do it once more.',
      ],
      tips: ['The Edge trick starts like a wave: R U R\' U, R U2 R\', then one more U.', 'Only turn the top layer between tricks. Do not turn the whole cube here.'],
      algs: [{ name: 'Edge trick', moves: "R U R' U R U2 R' U", note: 'Swaps the front and left yellow edges.' }],
    },
    {
      id: 'ycorners',
      title: 'Yellow Corners Home',
      emoji: '🏠',
      subtitle: 'Move corners to the right spot (twisting is fine)',
      stage: 'ycorners',
      story: [
        'Look at each yellow corner and the three centres around it. A corner is "home" when its three colours are the same as those three centres, even if it is twisted the wrong way round.',
        'Find a corner that is already home. Turn the whole cube so that corner is at the <b>front-right</b>. Do the <b>Corner trick</b>. The front-right corner stays put while the other three swap around.',
        'Check again. If the other corners are not home yet, do the Corner trick once more (keep the same corner at the front-right).',
        'If no corner is home at the start, do the Corner trick once from anywhere, and afterwards one corner will be home.',
      ],
      tips: ['Say the Corner trick in pairs: "U R, U\' L\', U R\', U\' L".', 'The last move is a plain L, not L\'. That one is easy to get wrong!'],
      algs: [{ name: 'Corner trick', moves: "U R U' L' U R' U' L", note: 'Front-right corner stays, the other three cycle.' }],
    },
    {
      id: 'ytwist',
      title: 'The Grand Finale',
      emoji: '🏆',
      subtitle: 'Twist the last corners and celebrate',
      stage: 'ytwist',
      story: [
        'All the corners are home, but some are twisted so their yellow sticker faces sideways. One more trick and you are done.',
        'Turn the top layer (only the top layer!) so a twisted corner is at the <b>front-right</b>. Do the <b>Twist trick</b> R\' D\' R D two times, then check. If yellow is not on top yet, do it two more times.',
        'IMPORTANT: the bottom two layers will look completely scrambled while you do this. <b>Do not panic and do not turn the whole cube.</b> Keep going: it all comes back at the end.',
        'When that corner has yellow on top, turn ONLY the top layer to bring the next twisted corner to the front-right and repeat. When every corner is yellow, turn the top layer to line it up. You solved the cube!',
      ],
      tips: ['Count your Twist tricks: it is always 2 or 4 for one corner.', 'Keep your right hand ready: R\' D\' R D uses only the right side and the bottom.'],
      algs: [{ name: 'Twist trick', moves: "R' D' R D", note: 'Repeat 2 or 4 times per corner. Only the top layer turns between corners.' }],
    },
  ];

  const STAGE_TITLES = {
    orient: 'Hold it right',
    daisy: 'Daisy',
    cross: 'White cross',
    corners: 'White corners',
    middle: 'Middle layer',
    ycross: 'Yellow cross',
    yedges: 'Yellow edges',
    ycorners: 'Yellow corners',
    ytwist: 'Twist corners',
    finish: 'Finish',
  };

  root.RC.LESSONS = LESSONS;
  root.RC.MOVE_WORDS = MOVE_WORDS;
  root.RC.STAGE_TITLES = STAGE_TITLES;
})(window);
