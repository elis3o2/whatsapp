module.exports = {
    async run(vars) {

        return {
            next: "ok",
            vars: {
                domicilio: vars.persona.domicilio
            }
        };

    }
};