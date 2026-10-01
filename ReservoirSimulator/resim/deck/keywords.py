"""Registry describing the data layout of ECLIPSE keywords.

Layouts:
    ("none",)                 flag keyword, no data
    ("record",)               a single record terminated by '/'
    ("records", N)            N records (N may be a dimension name, e.g. "NTPVT")
    ("array",)                numeric array terminated by '/'
    ("strings",)              list of strings terminated by '/'
    ("tables", N)             N numeric tables, each terminated by '/'
    ("table_records", N)      N tables made of records, each table ends with an empty '/'
    ("multi",)                list of records terminated by an empty '/'
"""
from __future__ import annotations

SECTIONS = {"RUNSPEC", "GRID", "EDIT", "PROPS", "REGIONS", "SOLUTION", "SUMMARY", "SCHEDULE"}

NONE = ("none",)
RECORD = ("record",)
ARRAY = ("array",)
STRINGS = ("strings",)
MULTI = ("multi",)

_FLAGS = """
OIL WATER GAS DISGAS VAPOIL BRINE SOLVENT POLYMER FIELD METRIC LAB PVT-M
UNIFOUT UNIFIN FMTOUT FMTIN NOSIM NOECHO ECHO ENDBOX NONNC FULLIMP IMPES AIM
CPR NOINSPEC NORSSPEC NOGGF GRIDFILE_ NEWTRAN OLDTRAN ALLPROPS ALL EXCEL RUNSUM
CO2STORE VAPWAT DISGASW SEPARATE RPTONLY MONITOR NOMONITO ENDSCALE_ SATOPTS_ THERMAL LIVEOIL ISGAS
FILLEPS MULTOUT MULTIN PERFORMA MSGFILE_ ENDFIN CO2STORE H2STORE DUMPFLUX
NEXTSTEP_ ISOTHERM PETOPTS_ FORMOPTS_ SMRYOPTS_
""".split()

_RECORD = """
DIMENS START TABDIMS TITLE WELLDIMS EQLDIMS REGDIMS COMPS EOS NCOMPS STCOND RTEMP
BOX GRIDFILE INIT_ MINPV MINPORV ROCKCOMP NSTACK TITLE RPTGRID RPTPROPS RPTSOL
RPTRST RPTSCHED RPTRUNSP RPTSMRY INCLUDE GRIDOPTS ENDSCALE SATOPTS MAPAXES MAPUNITS
GRIDUNIT TUNING_ NUPCOL MESSAGES MULTFLT_ AQUDIMS FAULTDIM VFPPDIMS VFPIDIMS
UDQDIMS UDADIMS PIMTDIMS NETWORK LGR ACTDIMS DATUM PETOPTS FORMOPTS SMRYOPTS
NEXTSTEP DRSDT DRVDT OPTIONS OPTIONS3 MISCIBLE SEPCOND_ WELLSTRE_ TEMPI_ NNEWTF
MSGFILE CART NPROCS PARALLEL MEMORY SALINITY
""".split()

_ARRAYS = """
DX DY DZ DXV DYV DZV TOPS PERMX PERMY PERMZ PORO NTG ACTNUM COORD ZCORN MULTX MULTY
MULTZ MULTX- MULTY- MULTZ- MULTPV PORV DEPTH TRANX TRANY TRANZ SATNUM PVTNUM EQLNUM
FIPNUM ROCKNUM IMBNUM MULTNUM FLUXNUM OPERNUM PRESSURE SWAT SGAS SOIL RS RV PBUB PDEW
SWATINIT SWL SWCR SWU SGL SGCR SGU SOWCR SOGCR KRW KRO KRG PCW PCG ISWL ISWCR ISWU
TCRIT PCRIT VCRIT ZCRIT ACF MW BIC ZI OMEGAA OMEGAB SSHIFT PARACHOR TBOIL TREF DREF
VCRITVIS ZCRITVIS TEMPI XMF YMF ZMF TSTEP COORDSYS HEATCR THCONR PERMXY PERMYZ PERMZX
NTG MINPVV PRVD_ HWKRO_ TOPS DPNUM MULTREGT_ ROCKTAB_ DIFFMMF CALVAL TCRITS PCRITS
""".split()

_STRINGS = """
CNAMES
""".split()

_MULTI = """
WELSPECS COMPDAT WCONPROD WCONINJE WCONHIST WCONINJH WECON WTEST WELOPEN WELTARG
WPIMULT DATES EQUALS MULTIPLY ADD COPY MINVALUE MAXVALUE OPERATE FAULTS MULTFLT
EDITNNC NNC WINJGAS WELLSTRE SEPCOND WSEPCOND GCONPROD GCONINJE GRUPTREE COMPORD
AQUCT AQUANCON AQUFETP WINJMIX WSOLVENT WPOLYMER WCONINJP COMPLUMP WLIST WGRUPCON
MULTREGT THPRES WPAVE WVFPEXP COMPSEGS WELSEGS UDQ ACTIONX MULTREGP WTEMP
""".split()

# numbered tables: {keyword: count spec}
_TABLES = {
    "SWOF": "NTSFUN", "SGOF": "NTSFUN", "SWFN": "NTSFUN", "SGFN": "NTSFUN",
    "SOF3": "NTSFUN", "SOF2": "NTSFUN", "SLGOF": "NTSFUN", "SGWFN": "NTSFUN",
    "PVDO": "NTPVT", "PVDG": "NTPVT", "PVCDO": "NTPVT", "PVTW": "NTPVT",
    "DENSITY": "NTPVT", "GRAVITY": "NTPVT", "ROCK": "NTROCC", "ROCKTAB": "NTROCC",
    "RSVD": "NTEQUL", "RVVD": "NTEQUL", "PBVD": "NTEQUL", "PDVD": "NTEQUL",
    "TEMPVD": "NTEQUL", "ZMFVD": "NTEQUL", "PRVD": "NTEQUL", "RTEMPVD": "NTEQUL",
    "SPECHEAT": "NTPVT", "OILVISCT": "NTPVT", "WATVISCT": "NTPVT", "GASVISCT": "NTPVT", "WATDENT": "NTPVT",
    "WSF": "NTSFUN", "GSF": "NTSFUN",
}
# records whose count is given by a dimension (one record per region)
_RECORDS = {"EQUIL": "NTEQUL"}

_TABLE_RECORDS = {"PVTO": "NTPVT", "PVTG": "NTPVT"}

_KNOWN = set(_FLAGS) | set(_RECORD) | set(_ARRAYS) | set(_STRINGS) | set(_MULTI) | set(_TABLES) \
    | set(_RECORDS) | set(_TABLE_RECORDS) | SECTIONS | {"END", "PATHS", "RTEMP", "TUNING"}


def is_known_keyword(name: str) -> bool:
    return name in _KNOWN


def keyword_layout(name: str, section: str):
    if name in _FLAGS:
        return NONE
    if name in _TABLE_RECORDS:
        return ("table_records", _TABLE_RECORDS[name])
    if name in _TABLES:
        # PVTW / DENSITY / ROCK are single-line records per region; parse as tables
        return ("tables", _TABLES[name])
    if name in _RECORDS:
        return ("records", _RECORDS[name])
    if name == "TITLE":
        return ("line",)
    if name == "TUNING":
        return ("records", 3)
    if name == "PATHS":
        return MULTI
    if name in _STRINGS:
        return STRINGS
    if name in _ARRAYS:
        return ARRAY
    if name in _MULTI:
        return MULTI
    if name in _RECORD:
        return RECORD
    if section == "SUMMARY":
        # Field/aggregate vectors have no data, well/group/region/block vectors take a list
        if name[0] in "F" or name in ("DATE", "TIMESTEP", "ELAPSED", "NEWTON", "MLINEARS", "TCPU"):
            return NONE
        if name[0] in "WGCRBAS":
            return RECORD if name[0] != "C" and name[0] != "B" else MULTI
        return NONE
    return ("unknown",)
