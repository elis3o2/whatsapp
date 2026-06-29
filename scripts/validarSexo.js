module.exports = {
    async run(vars) {

        const sexo = (vars.sexo || "")
            .toString()
            .trim()
            .toUpperCase();

        let sexoNormalizado = null;

        switch (sexo) {
            case "1":
            case "F":
            case "FEMENINO":
                sexoNormalizado = "F";
                break;

            case "2":
            case "M":
            case "MASCULINO":
                sexoNormalizado = "M";
                break;

            default:
                return {
                    next: "error"
                };
        }

        vars.sexo = sexoNormalizado;

        return {
            next: "ok",
            vars
        };
    }
};