# Legacy save fixtures

Genuine saves written by older versions of the game. **None of them was edited by hand and none is a current save
relabelled as old.** Each one is the text that the old game's own code put into `localStorage`, produced by
running that checkout's `src/` (its `createGame`, `update`, `serialize` and, for 0.17.1, its `writeSlot`) under
Node, with `tools/make-legacy-fixture.mjs` as the only script that touches them.

| File | Game | Commit | What it is |
|---|---|---|---|
| `v0.9.0-quick.json` | 0.9.0 (`master`) | `4a6cd57` | A bare shift, shift version 16, as 0.9 stored it under `firestation.save.v16`: no envelope |
| `v0.17.1-quick.json` | 0.17.1 (`new-changes`) | `bcd36bb` | A Quick Response envelope, shift version 17 |
| `v0.17.1-career.json` | 0.17.1 | `bcd36bb` | A Career envelope: shift version 17 plus the campaign (version 1) |
| `v0.17.1-challenge.json` | 0.17.1 | `bcd36bb` | A Challenge envelope (Mass Casualty), shift version 17 |

`manifest.json` records, for each file, what it should contain (vehicles, patients, stretcher cases, vehicles on
the road, personnel, scenario) so the tests can check that a load kept it all.

## How they were made

The old code was checked out into temporary worktrees outside the repository (the branches themselves were not
touched) and the generator was run against each:

```
git worktree add --detach <dir-09>  4a6cd57
git worktree add --detach <dir-171> bcd36bb
node tools/make-legacy-fixture.mjs <dir-09>  bare      test/fixtures/legacy/v0.9.0-quick.json
node tools/make-legacy-fixture.mjs <dir-171> quick     test/fixtures/legacy/v0.17.1-quick.json
node tools/make-legacy-fixture.mjs <dir-171> career    test/fixtures/legacy/v0.17.1-career.json
node tools/make-legacy-fixture.mjs <dir-171> challenge test/fixtures/legacy/v0.17.1-challenge.json
git worktree remove <dir-09> ; git worktree remove <dir-171>
```

The generator plays a short deterministic shift with that checkout's own code: it buys an ambulance, a ladder,
a rescue unit and a tanker, seeds the call generator, puts two people in the water, sends everything with
"Dispatch all" every two seconds, and stops at the first moment (after 2.5 minutes of game time) when a good
number of things are going on at once: a fire, vehicles on the road, injured people, someone in the water, and
patients on stretchers. So each fixture is a save made in the middle of an incident, which is where the
interesting loader bugs are. The challenge fixture is the Mass Casualty scenario; the career one is a new career
named "Legacy Fixture".

Do not regenerate these with the current code: they exist to prove that what old builds wrote still loads.
