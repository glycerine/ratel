// Copyright 2017-2018 Dgraph Labs, Inc. and Contributors
//
// Licensed under the Dgraph Community License (the "License"); you
// may not use this file except in compliance with the License. You
// may obtain a copy of the License at
//
//     https://github.com/dgraph-io/ratel/blob/master/LICENSE

import React from "react";
import Raven from "raven-js";

import FrameLayout from "./FrameLayout";
import FrameSession from "./FrameSession";
import FrameError from "./FrameError";
import FrameSuccess from "./FrameSuccess";
import FrameLoading from "./FrameLoading";

import { executeQuery, isNotEmpty } from "../lib/helpers";
import { GraphParser } from "../lib/graph";

export default class FrameItem extends React.Component {
    constructor(props) {
        super(props);

        this.state = {
            errorMessage: null,
            requestedVersion: 0,
            receivedVersion: 0,
            graphParser: new GraphParser(),
            parsedResponse: null,
            rawResponse: null,
            successMessage: null,
        };
    }

    componentDidMount() {
        this.props.frame.version = this.props.frame.version || 1;
        this.maybeExecuteFrameQuery();
    }

    componentDidUpdate() {
        this.props.frame.version = this.props.frame.version || 1;

        this.maybeExecuteFrameQuery();
    }

    maybeExecuteFrameQuery = () => {
        const { frame } = this.props;
        const { requestedVersion } = this.state;
        const { action, extraQuery, meta, query } = frame;

        if (requestedVersion >= frame.version) {
            // Latest frame data is already pending
            return;
        }

        if (meta.collapsed || !query) {
            // Frame is collapsed or empty, ignore.
            return;
        }

        // Invariant: there's data to fetch at this line.
        if (!requestedVersion) {
            // Nothing has been fetched at all. Do initial load.
            this.executeFrameQuery(query, action);
        } else {
            // We have requested something, if we got here - extra version has
            // incremented since last fetch, run extraQuery and update frame.
            this.executeFrameQuery(extraQuery, action);
        }
    };

    cleanFrameData = () =>
        this.setState({
            errorMessage: null,
            requestedVersion: 0,
            receivedVersion: 0,
            graphParser: new GraphParser(),
            parsedResponse: null,
            rawResponse: null,
            successMessage: null,
        });

    executeOnJsonClick = () => {
        const { frame, url } = this.props;
        const { query, action } = frame;

        if (action !== "query") {
            return;
        }

        const executionStart = Date.now();
        executeQuery(url, query, action, false).then(rawResponse => {
            this.updateFrameTiming(executionStart, rawResponse);
            this.setState({ rawResponse });
        });
    };

    updateFrameTiming = (executionStart, response) => {
        if (
            !response ||
            !response.extensions ||
            !response.extensions.server_latency
        ) {
            return;
        }
        const { frame, patchFrame } = this.props;
        const {
            parsing_ns,
            processing_ns,
            encoding_ns,
        } = response.extensions.server_latency;
        const fullRequestTimeNs = (Date.now() - executionStart) * 1e6;
        const serverLatencyNs = parsing_ns + processing_ns + encoding_ns;
        patchFrame(frame.id, {
            serverLatencyNs,
            networkLatencyNs: fullRequestTimeNs - serverLatencyNs,
        });
    };

    handleExpandResponse = () => {
        const { graphParser } = this.state;
        graphParser.processQueue();
        this.updateParsedResponse();
    };

    updateParsedResponse = rawResponse => {
        const { graphParser, parsedResponse } = this.state;
        rawResponse =
            rawResponse || (parsedResponse && parsedResponse.rawResponse);
        const {
            nodes,
            edges,
            labels,
            remainingNodes,
        } = graphParser.getCurrentGraph();

        if (nodes.length === 0) {
            this.setState({
                successMessage: "Your query did not return any results",
            });
            return;
        }

        this.setState({
            parsedResponse: {
                edges: edges,
                nodes: nodes,
                numNodes: nodes.length,
                numEdges: edges.length,
                plotAxis: labels,
                rawResponse,
                remainingNodes,
                treeView: false,
            },
        });
    };

    executeFrameQuery = (query, action) => {
        const {
            frame: { meta, version },
            url,
            onUpdateConnectedState,
        } = this.props;

        this.setState({
            requestedVersion: Math.max(this.state.requestedVersion, version),
        });

        const executionStart = Date.now();
        executeQuery(url, query, action, true)
            .then(res => {
                const { receivedVersion } = this.state;
                if (receivedVersion >= version) {
                    // Ignore request that has arrived too late.
                    return;
                }
                this.updateFrameTiming(executionStart, res);

                this.setState({
                    rawResponse: res,
                    receivedVersion: version,
                });
                onUpdateConnectedState(true);

                if (action === "query") {
                    if (res.errors) {
                        // Handle query error responses here.
                        this.setState({
                            errorMessage: res.errors[0].message,
                        });
                    } else if (isNotEmpty(res.data)) {
                        const regexStr = meta.regexStr || "Name";
                        const { graphParser } = this.state;

                        graphParser.addResponseToQueue(res.data);
                        graphParser.processQueue(false, regexStr);

                        this.updateParsedResponse(res);
                    } else {
                        this.setState({
                            successMessage:
                                "Your query did not return any results",
                        });
                    }
                } else {
                    // Mutation or Alter.
                    if (res.errors) {
                        this.setState({
                            errorMessage: res.errors[0].message,
                        });
                    } else {
                        this.setState({
                            successMessage: res.data.message,
                        });
                    }
                }
            })
            .catch(error => this.processError(error, version));
    };

    async processError(error, receivedVersion) {
        let errorMessage;
        // If no response, it's a network error or client side runtime error.
        if (!error.response) {
            // Capture client side error not query execution error from server.
            // FIXME: This captures 404.
            Raven.captureException(error);
            this.props.onUpdateConnectedState(false);

            errorMessage = `${error.message}: Could not connect to the server`;
        } else {
            errorMessage = await error.response.text();
        }
        this.setState({
            errorMessage,
            receivedVersion,
            rawData: error,
        });
    }

    handleNodeSelected = selectedNode => {
        if (!selectedNode) {
            this.setState({
                selectedNode: null,
                hoveredNode: null,
                configuringNodeType: null,
            });
        } else {
            this.setState({ selectedNode });
        }
    };

    handleNodeHovered = node => {
        this.setState({ hoveredNode: node });
    };

    render() {
        const {
            frame,
            framesTab,
            onDiscardFrame,
            onSelectQuery,
            collapseAllFrames,
        } = this.props;
        const {
            rawResponse,
            errorMessage,
            receivedVersion,
            hoveredNode,
            parsedResponse,
            selectedNode,
            successMessage,
        } = this.state;

        let content;
        if (!receivedVersion) {
            content = <FrameLoading />;
        } else if (parsedResponse) {
            content = (
                <FrameSession
                    frame={frame}
                    framesTab={framesTab}
                    onExpandResponse={this.handleExpandResponse}
                    handleNodeHovered={this.handleNodeHovered}
                    handleNodeSelected={this.handleNodeSelected}
                    hoveredNode={hoveredNode}
                    selectedNode={selectedNode}
                    parsedResponse={parsedResponse}
                    rawResponse={rawResponse}
                    onJsonClick={this.executeOnJsonClick}
                />
            );
        } else if (successMessage) {
            content = (
                <FrameSuccess
                    rawResponse={rawResponse}
                    query={frame.query}
                    successMessage={successMessage}
                />
            );
        } else if (errorMessage) {
            content = (
                <FrameError
                    errorMessage={errorMessage}
                    rawResponse={rawResponse}
                    query={frame.query}
                />
            );
        }

        return (
            <FrameLayout
                frame={frame}
                response={rawResponse}
                onDiscardFrame={onDiscardFrame}
                onSelectQuery={onSelectQuery}
                collapseAllFrames={collapseAllFrames}
                responseFetched={receivedVersion > 0}
                onAfterExpandFrame={this.executeFrameQuery}
                onAfterCollapseFrame={this.cleanFrameData}
            >
                {content}
            </FrameLayout>
        );
    }
}
