// See Guarded.h: MinaCalc behind a C++ `try`, never an exception into Rust.
#include "MinaCalc/MinaCalc.h"
#include <vector>

extern "C" {
#include "Guarded.h"
}

namespace {

// throws like MinaCalc does on a chart it can't handle (for guarded_selftest)
[[gnu::noinline]] int throws_out_of_range(int i) {
	std::vector<int> none;
	return none.at(static_cast<size_t>(i));
}

constexpr size_t SKILLSET_COUNT = 8;

Ssr to_ssr(const std::vector<float> &skillsets) {
	return Ssr{
		skillsets[0], skillsets[1], skillsets[2], skillsets[3],
		skillsets[4], skillsets[5], skillsets[6], skillsets[7],
	};
}

} // namespace

extern "C" {

int guarded_calc_at_rate(CalcHandle *calc, const NoteInfo *rows, size_t num_rows, float music_rate, float score_goal, unsigned int keycount,
                         CalcMode mode, Ssr *out) {
	try {
		std::vector<NoteInfo> note_info(rows, rows + num_rows);
		auto skillsets = MinaSDCalc(note_info, music_rate, score_goal, keycount, mode == CalcMode::SSR, reinterpret_cast<Calc *>(calc));
		if (skillsets.size() < SKILLSET_COUNT) {
			return 2;
		}
		*out = to_ssr(skillsets);
		return 0;
	} catch (...) {
		return 1;
	}
}

int guarded_calc_all_rates(CalcHandle *calc, const NoteInfo *rows, size_t num_rows, unsigned int keycount, CalcMode mode,
                           MsdForAllRates *out) {
	try {
		std::vector<NoteInfo> note_info(rows, rows + num_rows);
		auto msd_vectors = MinaSDCalc(note_info, keycount, mode == CalcMode::SSR, reinterpret_cast<Calc *>(calc));
		if (msd_vectors.size() < 14) {
			return 2;
		}
		MsdForAllRates all_rates;
		for (size_t i = 0; i < 14; i++) {
			if (msd_vectors[i].size() < SKILLSET_COUNT) {
				return 2;
			}
			all_rates.msds[i] = to_ssr(msd_vectors[i]);
		}
		*out = all_rates;
		return 0;
	} catch (...) {
		return 1;
	}
}

// for Rust's test that the try above survives the compiler: 1 when the exception was caught here
int guarded_selftest() {
	try {
		return throws_out_of_range(3) == 0 ? 0 : 2;
	} catch (...) {
		return 1;
	}
}

}
