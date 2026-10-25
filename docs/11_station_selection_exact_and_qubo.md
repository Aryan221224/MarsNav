# 11 Station selection: exact first, QUBO beyond

"Which stations, in which order, fit in this EVA?" is an orienteering problem: maximise science value subject to the time, O₂ and battery budget of the whole round trip, with the walk between stations taken from one-to-all searches on the terrain.

## Exact: Held-Karp over subsets

`heldKarpSubsets()` in `engine/sortie.js` is Bellman-Held-Karp dynamic programming. For every set of stations and every last station it keeps the least travel time from the habitat; orders that visit the same set and end at the same station have the same future, so n! orders collapse into 2ⁿ·n states. Closing each set back to the habitat gives the best tour of every subset in one pass. The optimiser then checks each subset against the budget (with each station's stated task) and ranks by science value, then time.

| Candidates | Sets checked | Time (JavaScript, one core) |
|---|---|---|
| 6 (Jezero science targets) | 63 | under 1 ms |
| 15 | 32,767 | about 35 ms |

This replaced exhaustive enumeration of orders, which capped the optimiser at 7 candidates. The leg-time matrix is asymmetric (uphill is slower than downhill) and the DP handles that. A test checks it against brute force.

## Beyond 15: QUBO and simulated annealing

Above 15 candidates (for example when landmarks and crew pins are offered as stations) the selection is posed as a QUBO, a quadratic knapsack: binary x for each station, reward for science value, a bonus for pairs that share a loop (Clarke-Wright savings), and the budget as a squared penalty with binary slack. `annealQubo()` solves it by simulated annealing, the classical method quantum annealers are benchmarked against. The chosen set is then ordered by nearest neighbour, 2-opt and Or-opt, trimmed if it overruns, topped up if it has room, and improved by swapping stations in and out while the tour still fits. `exportQubo()` writes it in a form any QUBO solver takes (dimod's BinaryQuadraticModel, a quantum annealer, or a QAOA circuit).

**Measured against the exact optimum** on 30 synthetic 15-station EVAs (6 h budget, asymmetric walking times):

| Method | Mean time | Hit the optimum | Mean gap | Worst gap |
|---|---|---|---|---|
| Held-Karp (exact) | 31-35 ms | 30 of 30 | 0 | 0 |
| QUBO + simulated annealing + repair | 47 ms | 8 of 30 | 5.3 % | 15.7 % |
| + swap local search (as shipped) | 43 ms | 18 of 30 | 1.7 % | 7.9 % |

On the Jezero instance with the six science targets plus nine landmarks, both return the same answer.

**Why not a quantum or quantum-inspired solver.** At EVA sizes an exact method is both faster and provably optimal. The QPath project (quantum-behaved PSO, quantum-inspired evolutionary algorithm and quantum federated learning, assessed in research doc 35) found the same in its own benchmark: Held-Karp reaches the proven optimum at 12 stops in 13.8 ms, while QPSO takes 80 ms to reach it. No quantum hardware can fly on a Mars mission, and research doc 34 found no quantum algorithm with an advantage at this size. The QUBO form is kept because it is the correct interface if that changes.

## What else was adopted from QPath

| Idea | Where it went |
|---|---|
| Proven optimum as the reference for any heuristic | Exact vs QUBO tests and the table above |
| Or-opt chain moves alongside 2-opt, re-priced on the asymmetric matrix | QUBO tour polishing |
| Dead band before re-routing (QPath: re-route a vehicle only if its route got 8 % worse) | Closed-loop re-check keeps the crew's route unless the new one saves 8 % or a station changes (docs/09) |
| Reference scales pinned so costs before and after a change are comparable | Re-plans reuse the original plan's weights and reference scales |
| Paired runs on identical inputs and a Wilcoxon signed-rank test, reported whichever way it comes out | `validation/closed_loop_campaign.mjs` |
