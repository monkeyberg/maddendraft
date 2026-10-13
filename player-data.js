/*
 * Built-in player pool.
 * - Stars: real NFL players. Ratings are rough approximations, NOT official Madden
 *   ratings, and teams reflect the 2025 season. Swap in your own data via data/players.json.
 * - Depth: procedurally generated fictional players so 32 teams can fill 25 slots.
 * The pool is deterministic (fixed seed), so every client and the server see the same ids.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./draft-engine'));
  else root.MaddenPlayerData = factory(root.DraftEngine);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E) {
  'use strict';

  const NFL_TEAMS = ['ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB',
    'HOU', 'IND', 'JAX', 'KC', 'LV', 'LAC', 'LAR', 'MIA', 'MIN', 'NE', 'NO', 'NYG', 'NYJ', 'PHI',
    'PIT', 'SF', 'SEA', 'TB', 'TEN', 'WAS'];

  // name|team|pos|ovr
  const STARS = `Josh Allen|BUF|QB|96
Lamar Jackson|BAL|QB|96
Patrick Mahomes|KC|QB|95
Joe Burrow|CIN|QB|93
Jared Goff|DET|QB|89
Jalen Hurts|PHI|QB|89
Jayden Daniels|WAS|QB|88
Baker Mayfield|TB|QB|88
Justin Herbert|LAC|QB|87
Matthew Stafford|LAR|QB|87
Brock Purdy|SF|QB|86
Dak Prescott|DAL|QB|85
Jordan Love|GB|QB|85
C.J. Stroud|HOU|QB|84
Saquon Barkley|PHI|HB|97
Derrick Henry|BAL|HB|95
Bijan Robinson|ATL|HB|94
Jahmyr Gibbs|DET|HB|93
Christian McCaffrey|SF|HB|92
Jonathan Taylor|IND|HB|90
Josh Jacobs|GB|HB|90
De'Von Achane|MIA|HB|88
Kyren Williams|LAR|HB|85
Ashton Jeanty|LV|HB|82
Ja'Marr Chase|CIN|WR|98
Justin Jefferson|MIN|WR|98
CeeDee Lamb|DAL|WR|96
Amon-Ra St. Brown|DET|WR|95
Puka Nacua|LAR|WR|94
A.J. Brown|PHI|WR|93
Nico Collins|HOU|WR|92
Jaxon Smith-Njigba|SEA|WR|92
Malik Nabers|NYG|WR|91
Drake London|ATL|WR|90
Garrett Wilson|NYJ|WR|89
Davante Adams|LAR|WR|89
Mike Evans|TB|WR|89
Terry McLaurin|WAS|WR|89
Brian Thomas Jr.|JAX|WR|88
Tee Higgins|CIN|WR|88
DK Metcalf|PIT|WR|87
George Kittle|SF|TE|96
Trey McBride|ARI|TE|93
Brock Bowers|LV|TE|92
Mark Andrews|BAL|TE|88
Sam LaPorta|DET|TE|87
T.J. Hockenson|MIN|TE|85
Dalton Kincaid|BUF|TE|82
Penei Sewell|DET|RT|97
Trent Williams|SF|LT|96
Tristan Wirfs|TB|LT|95
Lane Johnson|PHI|RT|94
Jordan Mailata|PHI|LT|94
Rashawn Slater|LAC|LT|92
Christian Darrisaw|MIN|LT|90
Kolton Miller|LV|LT|90
Laremy Tunsil|WAS|LT|89
Garett Bolles|DEN|LT|88
Joe Thuney|CHI|LG|95
Quinn Meinerz|DEN|RG|94
Chris Lindstrom|ATL|RG|94
Landon Dickerson|PHI|LG|92
Tyler Smith|DAL|LG|92
Quenton Nelson|IND|LG|92
Trey Smith|KC|RG|91
Kevin Zeitler|TEN|RG|88
Creed Humphrey|KC|C|96
Tyler Linderbaum|BAL|C|92
Drew Dalman|CHI|C|88
Cam Jurgens|PHI|C|88
Erik McCoy|NO|C|87
Myles Garrett|CLE|RE|99
Micah Parsons|GB|LE|97
T.J. Watt|PIT|LE|96
Maxx Crosby|LV|RE|96
Nick Bosa|SF|RE|94
Aidan Hutchinson|DET|LE|93
Danielle Hunter|HOU|RE|93
Trey Hendrickson|CIN|RE|92
Will Anderson Jr.|HOU|LE|92
Brian Burns|NYG|LE|90
Josh Hines-Allen|JAX|RE|90
Jared Verse|LAR|LE|89
Abdul Carter|NYG|RE|80
Chris Jones|KC|DT|96
Dexter Lawrence|NYG|DT|96
Jalen Carter|PHI|DT|93
Jeffery Simmons|TEN|DT|93
Quinnen Williams|DAL|DT|92
Zach Allen|DEN|DT|91
Cameron Heyward|PIT|DT|90
Leonard Williams|SEA|DT|90
Vita Vea|TB|DT|89
Nnamdi Madubuike|BAL|DT|88
Fred Warner|SF|MLB|97
Roquan Smith|BAL|MLB|94
Zack Baun|PHI|OLB|91
Jack Campbell|DET|MLB|91
Bobby Wagner|WAS|MLB|88
Foyesade Oluokun|JAX|MLB|87
Patrick Queen|PIT|MLB|86
Nick Bolton|KC|MLB|85
Patrick Surtain II|DEN|CB|97
Derek Stingley Jr.|HOU|CB|95
Sauce Gardner|IND|CB|93
Trent McDuffie|KC|CB|93
Christian Gonzalez|NE|CB|92
Jaycee Horn|CAR|CB|91
Quinyon Mitchell|PHI|CB|90
Denzel Ward|CLE|CB|90
Devon Witherspoon|SEA|CB|89
Marlon Humphrey|BAL|CB|88
Jalen Ramsey|PIT|CB|88
Kyle Hamilton|BAL|SS|96
Derwin James Jr.|LAC|SS|94
Kerby Joseph|DET|FS|93
Xavier McKinney|GB|FS|92
Antoine Winfield Jr.|TB|SS|91
Jessie Bates III|ATL|FS|90
Brian Branch|DET|SS|89
Budda Baker|ARI|SS|89
Minkah Fitzpatrick|MIA|FS|88`;

  const FIRST = ['Marcus', 'Devin', 'Tre', 'Jalen', 'Cole', 'Isaiah', 'Brandon', 'Xavier', 'Darius', 'Trevor',
    'Malik', 'Caleb', 'Jordan', 'Andre', 'Tyrell', 'Garrett', 'Keon', 'Rashad', 'Elijah', 'Bryce',
    'Dominic', 'Quentin', 'Lamont', 'Hunter', 'Cedric', 'Mason', 'Terrance', 'Logan', 'Jaylen', 'Desmond',
    'Wyatt', 'Kendrick', 'Ty', 'Nolan', 'Reggie', 'Damon', 'Colby', 'Javon', 'Austin', 'Micah',
    'Grant', 'Zion', 'Shane', 'Derrick', 'Corey', 'Emmanuel', 'Luke', 'Omar', 'Tavion', 'Brody'];
  const LAST = ['Whitfield', 'Okafor', 'Brennan', 'Castillo', 'Holloway', 'Pruitt', 'Vance', 'Mercer', 'Dunlap', 'Sutton',
    'Ashford', 'Granger', 'Kincaid', 'Rivers', 'Lyle', 'McAllister', 'Booker', 'Tate', 'Hargrove', 'Ellison',
    'Fontenot', 'Barksdale', 'Crowder', 'Pemberton', 'Strickland', 'Odom', 'Bridges', 'Calloway', 'Hensley', 'Mabry',
    'Quarles', 'Rutledge', 'Stallworth', 'Talbert', 'Underwood', 'Vickers', 'Wardlaw', 'Yancey', 'Zeller', 'Akins',
    'Boudreaux', 'Coleman', 'Delacroix', 'Easley', 'Fairley', 'Gaines', 'Hollins', 'Iverson', 'Jessup', 'Kearse',
    'Lockett', 'Murrell', 'Nwosu', 'Ogletree', 'Pickens', 'Ransom', 'Sowell', 'Toliver', 'Upshaw', 'Wilburn'];

  // Total pool size per position group (stars included). Sized so 32 teams can
  // always finish, even if every team uses its backup slot on the same position.
  const TARGETS = { QB: 72, RB: 92, WR: 200, TE: 112, OT: 112, OG: 112, C: 72, EDGE: 112, IDL: 112, LB: 112, CB: 160, S: 112 };
  const DETAIL_CYCLE = { QB: ['QB'], RB: ['HB'], WR: ['WR'], TE: ['TE'], OT: ['LT', 'RT'], OG: ['LG', 'RG'], C: ['C'],
    EDGE: ['LE', 'RE'], IDL: ['DT'], LB: ['MLB', 'OLB', 'OLB'], CB: ['CB'], S: ['FS', 'SS'] };

  function buildRaw(seed) {
    const rng = E.createRng(seed || 'madden-pool-v1');
    const raw = [];
    const names = new Set();
    const groupCount = {};
    E.ALL_POS.forEach(p => { groupCount[p] = 0; });

    STARS.trim().split('\n').forEach(line => {
      const [name, team, pos, ovr] = line.split('|');
      names.add(name);
      groupCount[E.POS_ALIASES[pos]]++;
      raw.push({ name, team, pos, ovr: Number(ovr) });
    });

    E.ALL_POS.forEach(group => {
      const n = Math.max(0, TARGETS[group] - groupCount[group]);
      const cycle = DETAIL_CYCLE[group];
      for (let i = 0; i < n; i++) {
        let name;
        do {
          name = FIRST[Math.floor(rng() * FIRST.length)] + ' ' + LAST[Math.floor(rng() * LAST.length)];
        } while (names.has(name));
        names.add(name);
        const curve = 85 - 27 * Math.pow(i / n, 0.8);
        const ovr = Math.round(Math.max(55, Math.min(86, curve + (rng() - 0.5) * 4)));
        raw.push({ name, team: NFL_TEAMS[Math.floor(rng() * NFL_TEAMS.length)], pos: cycle[i % cycle.length], ovr });
      }
    });
    return raw;
  }

  function buildPool(seed) {
    return E.normalizePool(buildRaw(seed), { seed: (seed || 'madden-pool-v1') + '|adp' });
  }

  return { NFL_TEAMS, buildPool, buildRaw, STAR_COUNT: STARS.trim().split('\n').length };
});
