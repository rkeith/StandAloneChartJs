(function () {
    var chartContainerId = "#standaloneChart";
    var statusId = "#chartStatus";
    var chartHeight = 750;
    var seriesColorPalette = [
        "DeepPink",
        "ForestGreen",
        "Indigo",
        "CadetBlue",
        "Chocolate",
        "Brown",
        "DimGray",
        "DarkKhaki",
        "Olive",
        "DeepSkyBlue"
    ];

    function showStatus(message) {
        $(statusId).text(message);
    }

    function parseSeriesValues(seriesText) {
        return (seriesText || "").split("|").map(function (value) {
            return value === "null" || value === "" ? null : parseFloat(value);
        });
    }

    function buildChartConfig(data) {
        var timeLabels = (data.tSeries || "").split("|");
        var missionDevices = data.mdList || [];

        var dataSeries = missionDevices.map(function (device) {
            return {
                seriesType: "line",
                drawWidth: 2,
                applyAnimation: { duration: 1500 },
                pointMark: { enabled: false },
                collectionAlias: device.mdName,
                data: parseSeriesValues(device.mdSeries)
            };
        });

        return {
            theme: "light",
            zoomMode: "x",
            height: chartHeight,
            seriesPalette: seriesColorPalette,
            exportOptions: {
                image: true,
                print: true
            },
            axisX: {
                axisType: "datetime",
                ticksRepeat: data.xAxisStep,
                axisTickText: {
                    textAngle: 0
                },
                categoricalValues: timeLabels
            },
            axisY: {
                min: data.yAxisMin,
                max: data.yAxisMax,
                ticksRepeat: data.yAxisStep,
                drawColor: "DarkGray",
                drawWidth: 2,
                plotLines: [
                    { start: data.lAlert, drawWidth: 2, drawColor: "Blue" },
                    { start: data.hAlert, drawWidth: 2, drawColor: "Crimson" }
                ],
                title: {
                    text: "Degrees C"
                }
            },
            tooltipSettings: {
                axisMarkers: {
                    enabled: true,
                    mode: "x",
                    width: 1,
                    zIndex: 3
                }
            },
            primaryHeader: {
                text: data.mName || "Mission Chart"
            },
            dataSeries: dataSeries
        };
    }

    function renderChart(data) {
        if (!data || !data.mdList || data.mdList.length === 0) {
            showStatus("No chart data found.");
            return;
        }

        showStatus("");
        $(chartContainerId).shieldChart(buildChartConfig(data));
    }

    function loadChart() {
        fetch("ChartData.json", { cache: "no-store" })
            .then(function (response) {
                if (!response.ok) {
                    throw new Error("Unable to load ChartData.json: HTTP " + response.status);
                }
                return response.json();
            })
            .then(renderChart)
            .catch(function (error) {
                console.error(error);
                showStatus("Chart data could not be loaded.");
            });
    }

    $(function () {
        loadChart();
    });
})();