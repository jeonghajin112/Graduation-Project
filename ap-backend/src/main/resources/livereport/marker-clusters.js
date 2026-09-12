function createLiveMarkerClusters({severityRanks, severityKey}) {
  const sortIssuesBySeverity = issues => issues.slice().sort((left, right) =>
    (severityRanks[severityKey(right)] || 0) - (severityRanks[severityKey(left)] || 0) || left.id - right.id);
  const clusterIssuesFor = entry => (entry.clusterMembers && entry.clusterMembers.size > 0)
    ? sortIssuesBySeverity([...entry.issues, ...Array.from(entry.clusterMembers).flatMap(member => member.issues)])
    : entry.issues;
  const entryForIssue = (host, issue) => {
    if (!host || !issue) return host;
    if (host.issues.includes(issue)) return host;
    for (const member of host.clusterMembers || []) {
      if (member.issues.includes(issue)) return member;
    }
    return host;
  };
  const leaveCluster = entry => {
    const host = entry.clusterHost;
    if (host && host.clusterMembers) host.clusterMembers.delete(entry);
    entry.clusterHost = null;
  };
  const joinCluster = (host, member) => {
    leaveCluster(member);
    member.clusterHost = host;
    if (!host.clusterMembers) host.clusterMembers = new Set();
    host.clusterMembers.add(member);
  };
  return {sortIssuesBySeverity, clusterIssuesFor, entryForIssue, leaveCluster, joinCluster};
}
