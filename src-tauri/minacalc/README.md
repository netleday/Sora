# MinaCalc

Etterna's difficulty calculator (MSD), version 527, as the
[minacalc-sys](https://crates.io/crates/minacalc-sys) crate (MIT) vendors it: `MinaCalc/` and
`Models/` are Etterna's code (MIT, licence in [LICENSE](LICENSE)), `API.cpp` / `API.h` the
crate's small C bridge. Left as they are; `build.rs` compiles `API.cpp` and
`MinaCalc/MinaCalc.cpp` into Fumen, and `src/msd.rs` calls them.
